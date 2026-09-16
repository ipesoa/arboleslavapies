#!/usr/bin/env python3
"""Lectura IMAP del buzón dedicado de Árboles Lavapiés."""
from __future__ import annotations

import email
import imaplib
import json
import re
import sqlite3
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.policy import default
from pathlib import Path

from secret_store import get_secret

MARKER_START = "---ARBOLES_LAVAPIES_JSON---"
MARKER_END = "---FIN_ARBOLES_LAVAPIES_JSON---"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_name(value: str, fallback: str = "archivo") -> str:
    name = Path(value or fallback).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    return name[:160] or fallback


def decode_subject(message) -> str:
    try:
        return str(make_header(decode_header(message.get("Subject", ""))))
    except Exception:
        return str(message.get("Subject", ""))


def text_body(message) -> str:
    if message.is_multipart():
        plain = []
        html = []
        for part in message.walk():
            disp = str(part.get("Content-Disposition", "")).lower()
            if "attachment" in disp:
                continue
            ctype = part.get_content_type()
            if ctype not in {"text/plain", "text/html"}:
                continue
            try:
                content = part.get_content()
            except Exception:
                raw = part.get_payload(decode=True) or b""
                content = raw.decode(part.get_content_charset() or "utf-8", errors="replace")
            (plain if ctype == "text/plain" else html).append(str(content))
        if plain:
            return "\n".join(plain)
        if html:
            # El bloque JSON enviado por mailto normalmente será text/plain.
            # Este fallback elimina etiquetas de manera conservadora.
            return re.sub(r"<[^>]+>", "", "\n".join(html))
        return ""
    try:
        return str(message.get_content())
    except Exception:
        raw = message.get_payload(decode=True) or b""
        return raw.decode(message.get_content_charset() or "utf-8", errors="replace")


def extract_payload(body: str):
    if MARKER_START not in body or MARKER_END not in body:
        return None
    raw = body.split(MARKER_START, 1)[1].split(MARKER_END, 1)[0].strip()
    return json.loads(raw)


def open_db(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute(
        """CREATE TABLE IF NOT EXISTS mail_messages(
        uid TEXT PRIMARY KEY,
        message_id TEXT,
        subject TEXT,
        submission_id TEXT,
        status TEXT NOT NULL,
        imported_at TEXT NOT NULL
        )"""
    )
    db.commit()
    return db


def save_attachments(message, target_dir: Path) -> list[Path]:
    target_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for part in message.walk():
        filename = part.get_filename()
        if not filename:
            continue
        try:
            filename = str(make_header(decode_header(filename)))
        except Exception:
            pass
        blob = part.get_payload(decode=True)
        if not blob:
            continue
        path = target_dir / safe_name(filename, "adjunto")
        n = 2
        while path.exists():
            path = target_dir / f"{path.stem}-{n}{path.suffix}"
            n += 1
        path.write_bytes(blob)
        saved.append(path)
    return saved


def pick_photo_attachment(payload: dict, paths: list[Path]):
    expected = safe_name(str(payload.get("photo_filename", "")), "")
    if expected:
        for path in paths:
            if path.name.lower() == expected.lower():
                return path
    for path in paths:
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
            return path
    return None


def sync_gmail(root: Path, config: dict) -> list[str]:
    email_addr = str(config.get("email", "")).strip()
    app_password = get_secret(root, "gmail_app_password").replace(" ", "").strip()
    if not email_addr or not app_password:
        raise RuntimeError("Falta configurar el correo o la contraseña de aplicación.")

    local = root / ".local"
    submissions = root / "submissions"
    attachments_root = local / "attachments"
    db = open_db(local / "gestor.sqlite3")
    logs = []

    imap = imaplib.IMAP4_SSL(config.get("imap_host", "imap.gmail.com"), int(config.get("imap_port", 993)))
    try:
        imap.login(email_addr, app_password)
        typ, _ = imap.select(str(config.get("mailbox", "INBOX")), readonly=True)
        if typ != "OK":
            raise RuntimeError("No se pudo abrir INBOX.")
        typ, data = imap.uid("search", None, "ALL")
        if typ != "OK":
            raise RuntimeError("No se pudo listar el buzón.")
        uids = (data[0] or b"").split()
        new_count = 0
        ignored = 0
        errors = 0
        # Dedicado al proyecto: recorrer todo es simple. SQLite evita duplicados.
        for raw_uid in uids:
            uid = raw_uid.decode("ascii", errors="ignore")
            if db.execute("SELECT 1 FROM mail_messages WHERE uid=?", (uid,)).fetchone():
                continue
            typ, fetched = imap.uid("fetch", raw_uid, "(RFC822)")
            if typ != "OK" or not fetched or not isinstance(fetched[0], tuple):
                errors += 1
                continue
            message = email.message_from_bytes(fetched[0][1], policy=default)
            subject = decode_subject(message)
            message_id = str(message.get("Message-ID", ""))
            status = "ignored"
            submission_id = None
            try:
                payload = extract_payload(text_body(message))
                is_bundle = isinstance(payload, dict) and payload.get("format") == "arboleslavapies.bundle.v1" and isinstance(payload.get("items"), list)
                if is_bundle:
                    bundle_id = str(payload.get("bundle_id") or f"mail_{uid}")
                    submission_id = bundle_id
                    target = attachments_root / safe_name(bundle_id)
                    attachments = save_attachments(message, target)
                    submissions.mkdir(parents=True, exist_ok=True)
                    imported_here = 0
                    for index, item in enumerate(payload.get("items", []), start=1):
                        if not isinstance(item, dict) or not item.get("type"):
                            continue
                        item = dict(item)
                        item_id = str(item.get("submission_id") or f"{bundle_id}_{index}")
                        item["submission_id"] = item_id
                        item["_source_email_uid"] = uid
                        item["_source_bundle_id"] = bundle_id
                        if item.get("type") == "photo":
                            selected = pick_photo_attachment(item, attachments)
                            if selected:
                                item["_attachment_path"] = str(selected.resolve())
                        out = submissions / f"mail-{safe_name(item_id)}.json"
                        out.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
                        imported_here += 1
                        logs.append(f"Aportación importada: {item.get('type')} · {item.get('alias', 'Anónimo')}")
                    if imported_here:
                        status = "imported"
                        new_count += imported_here
                        logs.append(f"Correo agrupado importado: {imported_here} aportación(es).")
                    else:
                        ignored += 1
                elif isinstance(payload, dict) and payload.get("type"):
                    submission_id = str(payload.get("submission_id") or f"mail_{uid}")
                    payload["submission_id"] = submission_id
                    payload["_source_email_uid"] = uid
                    target = attachments_root / safe_name(submission_id)
                    attachments = save_attachments(message, target)
                    if payload.get("type") == "photo":
                        selected = pick_photo_attachment(payload, attachments)
                        if selected:
                            payload["_attachment_path"] = str(selected.resolve())
                    submissions.mkdir(parents=True, exist_ok=True)
                    out = submissions / f"mail-{safe_name(submission_id)}.json"
                    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    status = "imported"
                    new_count += 1
                    logs.append(f"Correo importado: {payload.get('type')} · {payload.get('alias', 'Anónimo')}")
                else:
                    ignored += 1
            except Exception as exc:
                status = "error"
                errors += 1
                logs.append(f"Correo {uid}: no se pudo interpretar · {exc}")
            db.execute(
                "INSERT OR REPLACE INTO mail_messages(uid,message_id,subject,submission_id,status,imported_at) VALUES(?,?,?,?,?,?)",
                (uid, message_id, subject, submission_id, status, utcnow()),
            )
            db.commit()
        logs.append(f"Gmail: {new_count} aportación(es) nueva(s), {ignored} correo(s) ignorado(s), {errors} error(es).")
        return logs
    finally:
        try:
            imap.logout()
        except Exception:
            pass
        db.close()
