#!/usr/bin/env python3
import os, re, sys
from bs4 import BeautifulSoup, Tag, NavigableString

LABELABLE = {'input','select','textarea','button','meter','output','progress'}
CONTROLS  = {'input','select','textarea'}

def build_cum(text):
    cum=[0]
    for l in text.split('\n'):
        cum.append(cum[-1]+len(l)+1)
    return cum
def char_offset(cum, line, pos): return cum[line-1]+pos
def esc_attr(s): return s.replace('&','&amp;').replace('"','&quot;').replace('<','&lt;').replace('>','&gt;')
def norm_text(s):
    s=re.sub(r'\s+',' ',(s or '')).strip()
    return s.rstrip(':').strip()
def input_type(tag): return (tag.get('type') or 'text').strip().lower()
def is_control_needing(tag):
    if tag.name not in CONTROLS: return False
    if tag.name=='input' and input_type(tag)=='hidden': return False
    return True
def label_text(lbl): return norm_text(lbl.get_text(' ', strip=True))
def first_labelable(lbl):
    for d in lbl.descendants:
        if isinstance(d,Tag) and d.name in LABELABLE:
            if d.name=='input' and input_type(d)=='hidden': continue
            return d
    return None
def has_accessible_name(tag, labelfor_ids):
    al=tag.get('aria-label')
    if al is not None and al.strip(): return True
    if tag.get('aria-labelledby'): return True
    if tag.get('title') and tag.get('title').strip(): return True
    tid=tag.get('id')
    if tid and tid in labelfor_ids: return True
    anc=tag.find_parent('label')
    if anc is not None and first_labelable(anc) is tag and label_text(anc): return True
    if tag.name=='input':
        t=input_type(tag)
        if t in ('submit','reset','button') and (tag.get('value') or '').strip(): return True
        if t=='image' and (tag.get('alt') or '').strip(): return True
    return False
def prev_element_sibling(tag):
    for s in tag.previous_siblings:
        if isinstance(s,NavigableString):
            if s.strip()=='': continue
            return ('text',s)
        if isinstance(s,Tag): return ('tag',s)
    return (None,None)

def next_element_sibling(tag):
    for s in tag.next_siblings:
        if isinstance(s,NavigableString):
            if s.strip()=='': continue
            return ('text',s)
        if isinstance(s,Tag): return ('tag',s)
    return (None,None)
def in_aria_hidden(tag):
    for p in tag.parents:
        if isinstance(p,Tag):
            if (p.get('aria-hidden') or '').strip().lower()=='true': return True
            if p.name=='template': return True
    if (tag.get('aria-hidden') or '').strip().lower()=='true': return True
    return False
def count_controls(el):
    n=0
    for d in el.descendants:
        if isinstance(d,Tag) and is_control_needing(d): n+=1
    return n
def cap(s,n=140):
    s=norm_text(s)
    return s if len(s)<=n else s[:n].rstrip()


def _strings_excluding(el, ctrl):
    out=[]
    for d in el.descendants:
        if isinstance(d,NavigableString):
            par=d.parent
            skip=False
            p=par
            while isinstance(p,Tag):
                if p is ctrl or p.name in ('option','script','style'): skip=True; break
                p=p.parent
            if not skip and d.strip(): out.append(str(d))
    return norm_text(' '.join(out))
def text_from(container, ctrl):
    if not isinstance(container,Tag): return ''
    # prefer a descendant <label> element (not wrapping the control)
    for d in container.descendants:
        if isinstance(d,Tag) and d.name=='label' and not (ctrl is not None and (d is ctrl or ctrl in d.parents)):
            if ctrl is None or ctrl not in d.descendants:
                txt=_strings_excluding(d,ctrl)
                if txt and re.search(r'[A-Za-z]',txt): return cap(txt)
    # then a child styled as a label/name/title
    for d in container.descendants:
        if not isinstance(d,Tag): continue
        if ctrl is not None and (d is ctrl or ctrl in d.parents): continue
        if d.name in ('option','script','style'): continue
        cls=' '.join(d.get('class') or [])
        if re.search(r'(label|name|title|question|qtext)',cls,re.I):
            txt=_strings_excluding(d,ctrl)
            if txt and re.search(r'[A-Za-z]',txt): return cap(txt)
    return cap(_strings_excluding(container,ctrl))
def first_option_name(sel):
    opts=sel.find_all('option')
    if not opts: return ''
    txt=norm_text(opts[0].get_text())
    txt=re.sub(r'^[\-\u2012-\u2015\s]+','',txt)
    txt=re.sub(r'[\-\u2012-\u2015\s]+$','',txt)
    txt=txt.rstrip('.').strip()
    if txt.lower() in ('none','select','choose','n/a','na','','--','—','...'): return ''
    if not re.search(r'[A-Za-z]',txt) or len(txt)<2: return ''
    return txt

def ok_name(s):
    return bool(s) and (re.search(r'[A-Za-z]',s) is not None) and len(re.sub(r'[^A-Za-z]','',s))>=2
def humanize(s):
    s=re.sub(r'[_\-]+',' ',s); s=re.sub(r'([a-z])([A-Z])',r'\1 \2',s); s=re.sub(r'\s+',' ',s).strip()
    return (s[:1].upper()+s[1:]) if s else s
def plan_fix1(soup):
    labelfor_ids=set()
    for lbl in soup.find_all('label'):
        if lbl.get('for'): labelfor_ids.add(lbl.get('for'))
    edits=[]; skipped=[]; consumed=set()
    stats={'for':0,'aria_text':0,'aria_fallback':0,'skipped':0,'already':0,'total':0}
    for tag in soup.find_all(list(CONTROLS)):
        if not is_control_needing(tag): continue
        if in_aria_hidden(tag): continue
        stats['total']+=1
        if has_accessible_name(tag,labelfor_ids): stats['already']+=1; continue
        tid=tag.get('id'); kind,sib=prev_element_sibling(tag)
        if tid and kind=='tag' and sib.name=='label' and not sib.get('for') \
           and first_labelable(sib) is None and label_text(sib) and id(sib) not in consumed:
            edits.append({'tag':sib,'attr':'for','value':tid}); consumed.add(id(sib))
            labelfor_ids.add(tid); stats['for']+=1; continue
        anc=tag.find_parent('label')
        nk,nsib=next_element_sibling(tag)
        par=tag.parent
        cands=[]  # (value, is_text_source)
        # (1) wrapping label, non-first labelable
        if anc is not None and first_labelable(anc) is not tag:
            cands.append((text_from(anc,tag),True))
        # (2) preceding sibling label/span
        if kind=='tag' and sib.name in ('label','span'):
            cands.append((text_from(sib,None),True))
        # (3) preceding text node
        if kind=='text': cands.append((cap(sib),True))
        # (4) following sibling label/span/div/p
        if nk=='tag' and nsib.name in ('span','div','p','label'):
            cands.append((text_from(nsib,None),True))
        elif nk=='text': cands.append((cap(nsib),True))
        # (5) parent single-control wrapper
        if isinstance(par,Tag) and par.name not in ('form','body','html','fieldset') and count_controls(par)==1:
            cands.append((text_from(par,tag),True))
        # (6) wrapper's preceding sibling label/span
        if isinstance(par,Tag) and count_controls(par)==1:
            k2,s2=prev_element_sibling(par)
            if k2=='tag' and s2.name in ('label','span') and not s2.get('for'):
                cands.append((text_from(s2,None),True))
        # (7) select first option placeholder
        if tag.name=='select':
            cands.append((first_option_name(tag),True))
        # (8) placeholder / (9) name / (10) id
        ph=tag.get('placeholder'); nm=tag.get('name')
        if ph and ph.strip(): cands.append((norm_text(ph),False))
        if nm and not re.match(r'^b_[0-9a-f_]+$',nm): cands.append((humanize(nm),False))
        if tid: cands.append((humanize(tid),False))
        chosen=None; is_text=True
        for v,istxt in cands:
            if ok_name(v): chosen=v; is_text=istxt; break
        if chosen:
            edits.append({'tag':tag,'attr':'aria-label','value':chosen})
            stats['aria_text' if is_text else 'aria_fallback']+=1; continue
        skipped.append(tag); stats['skipped']+=1
    return edits,stats,skipped
def css_heading_bare_styled(soup):
    css='\n'.join(st.get_text() for st in soup.find_all('style'))
    css=re.sub(r'/\*.*?\*/','',css,flags=re.S)
    for m in re.finditer(r'([^{}]+)\{[^{}]*\}',css):
        for sel in m.group(1).split(','):
            sel=sel.strip()
            if not sel: continue
            parts=re.split(r'\s*[>+~]\s*|\s+',sel)
            subj=parts[-1] if parts else sel
            if re.match(r'^h[1-6](:[a-zA-Z\-]+)*$',subj): return True
    return False
def plan_fix2(soup):
    heads=soup.find_all(re.compile(r'^h[1-6]$')); bare=css_heading_bare_styled(soup)
    edits=[]; fixes=[]; prev=0
    for h in heads:
        L=int(h.name[1]); corrected=L if prev==0 else min(L,prev+1)
        if corrected!=L:
            method='aria' if bare else 'relevel'
            edits.append({'kind':method,'tag':h,'from':L,'to':corrected}); fixes.append((L,corrected,method))
        prev=corrected
    return edits,fixes,bare
def apply_edits(text,attr_edits,level_edits):
    cum=build_cum(text); ops=[]
    for e in attr_edits:
        t=e['tag']; off=char_offset(cum,t.sourceline,t.sourcepos)
        ops.append((off+1+len(t.name),0,' %s="%s"'%(e['attr'],esc_attr(e['value']))))
    for e in level_edits:
        t=e['tag']; off=char_offset(cum,t.sourceline,t.sourcepos)
        if e['kind']=='aria':
            ops.append((off+1+len(t.name),0,' role="heading" aria-level="%d"'%e['to']))
        else:
            ops.append((off+1,len(t.name),'h%d'%e['to']))
            gt=text.index('>',off)
            m=re.compile(r'</%s\s*>'%re.escape(t.name),re.I).search(text,gt)
            if not m: raise RuntimeError('no close tag')
            ops.append((m.start()+2,len(t.name),'h%d'%e['to']))
    ops.sort(key=lambda o:o[0],reverse=True)
    b=text
    for off,dl,ins in ops: b=b[:off]+ins+b[off+dl:]
    return b
def process(text):
    soup=BeautifulSoup(text,'html.parser')
    f1,st1,skip1=plan_fix1(soup)
    f2,fx2,bare=plan_fix2(soup)
    changed=bool(f1 or f2)
    return (apply_edits(text,f1,f2) if changed else text), st1, skip1, fx2, bare, changed
if __name__=='__main__':
    mode=sys.argv[1] if len(sys.argv)>1 else 'audit'
    root='/tmp/flp'; outroot='/tmp/aw/out'
    files=[]
    for dp,dn,fn in os.walk(root):
        if '/.git' in dp: continue
        for f in fn:
            if f.endswith('.html'): files.append(os.path.join(dp,f))
    files.sort()
    tot={'for':0,'aria_text':0,'aria_fallback':0,'skipped':0,'already':0,'total':0}
    h_aria=h_relevel=0; pages_f1=set(); pages_f2=set(); pages_changed=set(); allskips=[]
    for p in files:
        text=open(p,encoding='utf-8').read()
        nt,st1,skip1,fx2,bare,changed=process(text)
        for k in tot: tot[k]+=st1[k]
        if st1['for']+st1['aria_text']+st1['aria_fallback']>0: pages_f1.add(p)
        if fx2: pages_f2.add(p)
        for L,c,m in fx2:
            if m=='aria': h_aria+=1
            else: h_relevel+=1
        for s in skip1: allskips.append((p,str(s)[:90]))
        if changed: pages_changed.add(p)
        if mode=='write' and changed:
            rel=os.path.relpath(p,root); out=os.path.join(outroot,rel)
            os.makedirs(os.path.dirname(out),exist_ok=True)
            open(out,'w',encoding='utf-8').write(nt)
    print('FILES scanned:',len(files))
    print('FIX1 totals:',tot)
    print('FIX1 pages changed:',len(pages_f1))
    print('FIX2 heading fixes: aria-level=%d relevel=%d across %d pages'%(h_aria,h_relevel,len(pages_f2)))
    print('TOTAL pages changed:',len(pages_changed))
    print('SKIPPED controls (%d):'%len(allskips))
    for p,s in allskips[:60]: print('   ',os.path.relpath(p,root),'|',s)
