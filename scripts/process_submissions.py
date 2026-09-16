#!/usr/bin/env python3
"""Consolidador local de Árboles Lavapiés.

Lee JSON de `submissions/`, valida identidades y publica sólo datos saneados.
Las altas/modificaciones de mapa, fotos y sugerencias quedan en `pending/`.
Los códigos secretos se usan para validar y se eliminan con el fichero de entrada.
"""
import argparse, hashlib, json, re, uuid
from datetime import datetime, timezone
from pathlib import Path

ALIAS_RE = re.compile(r'^[A-Za-zÀ-ÿ0-9._-]{3,28}$')
PUBLIC_EVENT_TYPES = {'watering','commitment','comment','issue'}
ISSUE_CATEGORIES = {'dry','damaged','missing','pit','pest','map_error','danger','other'}

def norm(s): return str(s).strip().casefold()
def digest(code): return hashlib.sha256(str(code).strip().upper().encode()).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat()

def load(path, default):
    p=Path(path)
    try: return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default
    except Exception: return default

def write(path, value):
    p=Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def safe_unlink(path):
    try: Path(path).unlink()
    except FileNotFoundError: pass

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--inbox',default='submissions')
    ap.add_argument('--site',default='docs')
    ap.add_argument('--pending',default='pending')
    args=ap.parse_args()

    site=Path(args.site); inbox=Path(args.inbox); pending=Path(args.pending)
    inbox.mkdir(parents=True,exist_ok=True); pending.mkdir(parents=True,exist_ok=True)
    users=load(site/'data/users.json',[])
    events=load(site/'data/events.json',[])
    meta=load(site/'data/meta.json',{'version':'0.4.1'})
    aliases={norm(u['alias']):u for u in users}
    event_submission_ids={str(e.get('submission_id')).split('::',1)[0] for e in events if e.get('submission_id')}

    items=[]
    for f in sorted(inbox.glob('*.json')):
        try: items.append((f,json.loads(f.read_text(encoding='utf-8'))))
        except Exception as e:
            print('JSON INVÁLIDO',f,e); safe_unlink(f)

    changed_users=False; changed_events=False; handled=set()

    # Altas de identidad primero: así una identidad y su primer riego pueden
    # entrar en la misma actualización diaria.
    for f,d in items:
        if d.get('type')!='identity_registration': continue
        handled.add(f)
        alias=str(d.get('alias','')).strip(); h=str(d.get('secret_hash','')).lower()
        if not ALIAS_RE.fullmatch(alias) or not re.fullmatch(r'[0-9a-f]{64}',h):
            print('REGISTRO RECHAZADO (formato)',alias or f.name); safe_unlink(f); continue
        existing=aliases.get(norm(alias))
        if existing:
            print('REGISTRO YA EXISTENTE' if existing.get('secret_hash')==h else 'REGISTRO RECHAZADO (alias ocupado)',alias)
            safe_unlink(f); continue
        u={'id':'u_'+uuid.uuid4().hex[:10],'alias':alias,'secret_hash':h,'created_at':d.get('created_at') or now()}
        users.append(u); aliases[norm(alias)]=u; changed_users=True
        print('USUARIO',alias); safe_unlink(f)

    for f,d in items:
        if f in handled: continue
        typ=d.get('type'); submission_id=str(d.get('submission_id') or '') or None
        if submission_id and submission_id in event_submission_ids:
            print('DUPLICADO',submission_id); safe_unlink(f); continue

        alias=str(d.get('alias','Anónimo')).strip() or 'Anónimo'; code=d.get('identity_code'); uid=None
        if alias!='Anónimo':
            u=aliases.get(norm(alias))
            if not u or not code or digest(code)!=u.get('secret_hash'):
                print('IDENTIDAD INVÁLIDA',f.name,alias); safe_unlink(f); continue
            uid=u['id']

        if typ in PUBLIC_EVENT_TYPES:
            base={
                'type':typ, 'place_id':d.get('place_id'), 'date':d.get('date') or now(),
                'note':str(d.get('note',''))[:1200], 'alias':alias, 'user_id':uid
            }
            if typ=='comment': base['reply_to']=str(d.get('reply_to',''))[:80] or None
            if typ=='issue':
                cat=str(d.get('issue_category','other'))
                base['issue_category']=cat if cat in ISSUE_CATEGORIES else 'other'
                base['status']='open'

            if typ=='commitment':
                raw_dates=d.get('planned_for_dates')
                if not isinstance(raw_dates,list): raw_dates=[d.get('planned_for')]
                dates=[]
                for value in raw_dates:
                    value=str(value or '')[:10]
                    if re.fullmatch(r'\d{4}-\d{2}-\d{2}',value) and value not in dates: dates.append(value)
                if not dates:
                    print('COMPROMISO RECHAZADO (sin fecha)',f.name); safe_unlink(f); continue
                for planned in dates:
                    e=dict(base)
                    e['id']='e_'+uuid.uuid4().hex[:12]
                    e['submission_id']=f'{submission_id}::{planned}' if submission_id else None
                    e['planned_for']=planned
                    events.append(e)
                changed_events=True
                if submission_id: event_submission_ids.add(submission_id)
                print('EVENTO commitment',d.get('place_id'),len(dates),'día(s)'); safe_unlink(f); continue

            e=dict(base)
            e['id']='e_'+uuid.uuid4().hex[:12]
            e['submission_id']=submission_id
            events.append(e); changed_events=True
            if submission_id: event_submission_ids.add(submission_id)
            print('EVENTO',typ,d.get('place_id')); safe_unlink(f); continue

        if typ in {'new_place','photo','suggestion'}:
            clean={
                'submission_id':submission_id,'type':typ,'date':d.get('date') or now(),
                'note':str(d.get('note') or d.get('caption') or '')[:1800],
                'alias':alias,'user_id':uid,'status':'pending'
            }
            if typ=='new_place': clean.update({'place_type':d.get('place_type','other'),'lat':d.get('lat'),'lon':d.get('lon')})
            if typ=='photo': clean.update({'place_id':d.get('place_id'),'photo_filename':Path(str(d.get('photo_filename',''))).name})
            if typ=='suggestion': clean.update({'category':str(d.get('category','other'))[:80]})
            dest=pending/(f'{typ}-{submission_id or f.stem}.json')
            write(dest,clean); print('PENDIENTE',dest); safe_unlink(f); continue

        print('TIPO DESCONOCIDO',f.name,typ); safe_unlink(f)

    if changed_users: write(site/'data/users.json',users)
    if changed_events: write(site/'data/events.json',events)
    meta['version']='0.4.1'
    meta['last_update']=now()
    write(site/'data/meta.json',meta)
    print('Actualización registrada:',meta['last_update'])

if __name__=='__main__': main()
