const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;

/* nav */
const nav=document.querySelector('nav');
addEventListener('scroll',()=>nav.classList.toggle('scrolled',scrollY>40),{passive:true});

/* mobilné hamburger menu – vygenerované z existujúcej navigácie (beží na každej podstránke) */
(function(){
  const inner=nav&&nav.querySelector('.nav-inner');
  const links=nav&&nav.querySelector('.nav-links');
  if(!inner||!links)return;

  const burger=document.createElement('button');
  burger.className='nav-burger';
  burger.type='button';
  burger.setAttribute('aria-label','Otvoriť menu');
  burger.setAttribute('aria-expanded','false');
  burger.setAttribute('aria-controls','mobileMenu');
  burger.innerHTML='<span></span><span></span><span></span>';
  inner.appendChild(burger);

  const menu=document.createElement('div');
  menu.className='mobile-menu';
  menu.id='mobileMenu';
  const ul=document.createElement('ul');
  ul.className='mm-links';
  Array.prototype.forEach.call(links.querySelectorAll('a'),function(a,i){
    const li=document.createElement('li');
    li.style.setProperty('--i',i);
    const na=document.createElement('a');
    na.href=a.getAttribute('href');
    if(a.target){na.target=a.target;if(a.rel)na.rel=a.rel;}
    na.textContent=a.textContent.trim();
    if(a.classList.contains('nav-tel'))na.className='mm-tel';
    else if(a.classList.contains('btn'))na.className='mm-cta';
    li.appendChild(na);ul.appendChild(li);
  });
  menu.appendChild(ul);
  document.body.appendChild(menu);

  let open=false;
  function setOpen(v){
    open=v;
    burger.classList.toggle('is-open',v);
    menu.classList.toggle('is-open',v);
    document.body.classList.toggle('menu-lock',v);
    burger.setAttribute('aria-expanded',v?'true':'false');
    burger.setAttribute('aria-label',v?'Zavrieť menu':'Otvoriť menu');
  }
  burger.addEventListener('click',()=>setOpen(!open));
  menu.addEventListener('click',e=>{if(e.target.closest('a')||e.target===menu)setOpen(false);});
  addEventListener('keydown',e=>{if(e.key==='Escape'&&open)setOpen(false);});
  addEventListener('resize',()=>{if(open&&innerWidth>920)setOpen(false);});
})();

/* reveal */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));

/* fade-in všetkých nadpisov pri scrolle */
document.querySelectorAll('h1,h2,h3').forEach(el=>{
  if(el.closest('nav,footer,.cookiebar'))return;
  el.classList.add('fade-head');
  io.observe(el);
});

/* marquee */
const mq=document.getElementById('mq');
if(mq)mq.innerHTML+=mq.innerHTML;

/* portfólio filter */
const filters=document.querySelectorAll('.filters button');
if(filters.length){
  filters.forEach(b=>b.addEventListener('click',()=>{
    filters.forEach(x=>x.classList.remove('on'));b.classList.add('on');
    const f=b.dataset.f;
    document.querySelectorAll('[data-cat]').forEach(card=>{
      card.style.display=(f==='all'||card.dataset.cat===f)?'':'none';
    });
  }));
}

/* ripple */
document.addEventListener('click',e=>{
  const b=e.target.closest('.btn,.pill,.filters button');
  if(!b||reduced)return;
  const r=b.getBoundingClientRect(),s=Math.max(r.width,r.height);
  const rip=document.createElement('span');rip.className='ripple';
  rip.style.width=rip.style.height=s+'px';
  rip.style.left=(e.clientX-r.left-s/2)+'px';rip.style.top=(e.clientY-r.top-s/2)+'px';
  b.appendChild(rip);setTimeout(()=>rip.remove(),600);
});

/* kruhový graf – animácia po zobrazení (dashoffset podľa data-pct) */
document.querySelectorAll('.ring').forEach(ring=>{
  const val=ring.querySelector('.val');if(!val)return;
  const pct=parseFloat(ring.dataset.pct||'75');
  const obs=new IntersectionObserver(es=>es.forEach(e=>{
    if(e.isIntersecting){
      requestAnimationFrame(()=>{val.style.strokeDashoffset=408-408*pct/100});
      obs.unobserve(ring);
    }
  }),{threshold:.4});
  obs.observe(ring);
});

/* hero slider rozpočtu */
const bud=document.getElementById('budget-range');
if(bud){
  const out=document.getElementById('budget-val');
  const fmt=v=>Number(v).toLocaleString('sk-SK')+' €';
  out.textContent=fmt(bud.value);
  bud.addEventListener('input',()=>out.textContent=fmt(bud.value));
}

/* kontaktný formulár – odosielanie cez vlastný PHP skript /send.php na nogrey@nogrey.sk */
const cf=document.getElementById('contact-form');
if(cf){
  /* telefón – iba čísla (povolené aj medzery a úvodné +) */
  if(cf.telefon)cf.telefon.addEventListener('input',()=>{cf.telefon.value=cf.telefon.value.replace(/[^\d+\s]/g,'');});
  cf.addEventListener('submit',async e=>{
    e.preventDefault();
    const note=document.getElementById('form-note');
    const btn=document.getElementById('form-send');
    /* vlastná validácia (novalidate kvôli jednotnému vzhľadu hlášok) */
    if(!cf.meno.value.trim()||!cf.email.value.trim()||!cf.telefon.value.trim()||!cf.sprava.value.trim()){
      note.textContent='Vyplňte prosím meno, e-mail, telefón a správu.';
      note.classList.add('show');return;
    }
    if(cf.telefon.value.replace(/\D/g,'').length<9){
      note.textContent='Zadajte prosím platné telefónne číslo (aspoň 9 číslic).';
      note.classList.add('show');return;
    }
    if(cf._honey.value)return; /* spam pasca */
    /* captcha (Turnstile) – ak je widget na stránke, vyžaduj token */
    const capEl=cf.querySelector('[name="cf-turnstile-response"]');
    const capToken=capEl?capEl.value:'';
    if(document.querySelector('.cf-turnstile')&&!capToken){
      note.textContent='Potvrďte prosím captcha (nie som robot).';
      note.classList.add('show');return;
    }
    btn.disabled=true;const orig=btn.textContent;btn.textContent='Odosielam…';
    try{
      const res=await fetch('/send.php',{
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({
          Meno:cf.meno.value.trim(),
          Email:cf.email.value.trim(),
          Telefon:cf.telefon.value.trim()||'–',
          Dopyt:cf.dopyt.value,
          Sprava:cf.sprava.value.trim(),
          _honey:cf._honey.value,
          'cf-turnstile-response':capToken
        })
      });
      if(!res.ok)throw new Error();
      note.textContent='Ďakujeme! Správa je odoslaná – ozveme sa do 24 hodín.';
      note.classList.add('show');
      cf.reset();
      if(window.turnstile)try{turnstile.reset();}catch(_){}
    }catch(err){
      note.textContent='Správu sa nepodarilo odoslať. Napíšte nám prosím priamo na nogrey@nogrey.sk.';
      note.classList.add('show');
    }
    btn.disabled=false;btn.textContent=orig;
  });
}

/* cookies lišta (GDPR) – vloží sa na každú stránku, kým používateľ nerozhodne */
(function(){
  var KEY='ng-cookies';
  if(localStorage.getItem(KEY))return;
  var bar=document.createElement('div');
  bar.className='cookiebar';
  bar.setAttribute('role','dialog');
  bar.setAttribute('aria-label','Súhlas s cookies');
  bar.innerHTML='<p>Používame nevyhnutné cookies na fungovanie webu. So súhlasom aj analytické – pomáhajú nám web zlepšovať. <a href="ochrana-osobnych-udajov.html">Viac o ochrane údajov</a></p>'+
    '<div class="cookiebar-btns"><button type="button" class="btn btn-primary" data-c="all">Prijať všetko</button>'+
    '<button type="button" class="btn btn-ghost" data-c="necessary">Len nevyhnutné</button></div>';
  document.body.appendChild(bar);
  requestAnimationFrame(function(){requestAnimationFrame(function(){bar.classList.add('show')})});
  bar.addEventListener('click',function(e){
    var b=e.target.closest('button[data-c]');if(!b)return;
    localStorage.setItem(KEY,b.dataset.c);
    /* sem neskôr: if(b.dataset.c==='all'){ nasadiť analytiku } */
    bar.classList.remove('show');
    setTimeout(function(){bar.remove()},350);
  });
})();

/* particles zemeguľa v hero (canvas, bez obrázka) */
const globe=document.getElementById('globe');
if(globe){
  const ctx=globe.getContext('2d');
  const dpr=Math.min(devicePixelRatio||1,2);
  const S=700;globe.width=S*dpr;globe.height=S*dpr;ctx.scale(dpr,dpr);
  const C=S/2,R=S*.42,N=1050,TILT=-.4;
  /* mapa sveta 5°: rady = zem. šírka 90N→90S, rozsahy = zem. dĺžka pevniny */
  const LAND={
    1:[[-110,-80],[-70,-25]],2:[[-115,-80],[-70,-20],[15,30],[100,145]],
    3:[[-125,-85],[-55,-25],[20,30],[60,180]],4:[[-165,-140],[-140,-65],[-25,-15],[12,180]],
    5:[[-165,-150],[-140,-95],[-90,-60],[-47,-42],[5,155]],
    6:[[-155,-130],[-130,-95],[-78,-60],[-8,-2],[8,140],[156,163]],
    7:[[-130,-55],[-10,145]],8:[[-125,-52],[-2,132],[141,146]],
    9:[[-124,-68],[-9,3],[7,18],[19,29],[40,47],[54,132],[139,142]],
    10:[[-122,-75],[-9,0],[12,15],[21,49],[54,122],[126,129],[132,141]],
    11:[[-120,-78],[-10,122],[130,134]],
    12:[[-113,-97],[-82,-79],[-15,34],[38,48],[56,60],[68,122]],
    13:[[-110,-97],[-87,-74],[-17,35],[39,58],[70,88],[92,116]],
    14:[[-105,-83],[-77,-61],[-17,39],[42,54],[73,85],[94,108],[120,126]],
    15:[[-87,-83],[-72,-61],[-17,42],[44,51],[75,80],[98,108],[120,125]],
    16:[[-83,-52],[-13,48],[80,82],[100,103],[113,119],[122,126]],
    17:[[-79,-51],[9,44],[95,103],[109,118],[120,124]],
    18:[[-80,-42],[10,40],[100,106],[110,116],[119,123],[130,151]],
    19:[[-79,-35],[12,40],[105,115],[124,127],[138,148]],
    20:[[-77,-37],[13,40],[48,50],[130,137],[141,143]],
    21:[[-72,-39],[13,37],[44,50],[122,146]],
    22:[[-70,-40],[14,36],[43,48],[113,150]],
    23:[[-71,-48],[16,33],[114,153]],24:[[-72,-57],[18,29],[115,152]],
    25:[[-73,-57],[140,150],[173,178]],26:[[-74,-63],[144,148],[168,177]],
    27:[[-75,-66],[166,171]],28:[[-74,-68]],30:[[-62,-57]],
    31:[[-68,-60],[45,160]],32:[[-85,-60],[-30,165]],
    33:[[-180,180]],34:[[-180,180]],35:[[-180,180]]
  };
  function isLand(lat,lon){
    const row=LAND[Math.min(35,Math.max(0,Math.floor((90-lat)/5)))];
    if(!row)return false;
    for(const [a,b] of row)if(lon>=a&&lon<=b)return true;
    return false;
  }
  const pts=[];
  const GA=Math.PI*(3-Math.sqrt(5)); /* zlatý uhol */
  for(let i=0;i<N;i++){
    const y=1-(i/(N-1))*2,r=Math.sqrt(1-y*y),th=GA*i;
    const x=Math.cos(th)*r,z=Math.sin(th)*r;
    const lat=-Math.asin(y)*180/Math.PI,lon=Math.atan2(z,x)*180/Math.PI;
    const land=isLand(lat,lon);
    if(!land&&Math.random()<.45)continue; /* oceán redší */
    pts.push({x,y,z,land,tw:Math.random()*Math.PI*2,
      sz:land?1.3+Math.random()*1.5:.8+Math.random()*1});
  }
  /* spojnice: dvojice blízkych bodov (pevné, aby neblikali) */
  const links=[];
  for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
    const a=pts[i],b=pts[j],dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z;
    if(dx*dx+dy*dy+dz*dz<.03&&Math.random()<.55)links.push([i,j,a.land&&b.land]);
  }
  const cosT=Math.cos(TILT),sinT=Math.sin(TILT);
  /* interakcia: klik → svetelná vlna po povrchu + krátke zrýchlenie rotácie */
  const pulses=[];
  let rot=0,boost=0,last=0,lastProj=[];
  function pokeGlobe(clientX,clientY){
    if(reduced)return;
    const rc=globe.getBoundingClientRect();
    const mx=(clientX-rc.left)*S/rc.width,my=(clientY-rc.top)*S/rc.height;
    let best=null,bd=Infinity;
    for(const q of lastProj){
      if(q.z<-.1)continue;
      const dx=q.sx-mx,dy=q.sy-my,d=dx*dx+dy*dy;
      if(d<bd){bd=d;best=q;}
    }
    if(best&&bd<130*130){
      pulses.push({p:best.p,t0:performance.now()});
      boost=Math.min(boost+.00028,.0007);
    }
  }
  /* reaguje na myš/dotyk – jemný lokálny záblesk pod prstom; sivý tap-highlight štvorec je vypnutý v CSS */
  globe.addEventListener('pointerdown',e=>pokeGlobe(e.clientX,e.clientY));
  function frame(t){
    const dt=Math.min(t-last,50);last=t;
    rot+=(.00008+boost)*dt;
    boost*=Math.pow(.9945,dt);
    for(let i=pulses.length-1;i>=0;i--)if(t-pulses[i].t0>1700)pulses.splice(i,1);
    ctx.clearRect(0,0,S,S);
    const proj=lastProj=pts.map(p=>{
      const cx=Math.cos(rot),sx=Math.sin(rot);
      let x=p.x*cx+p.z*sx,z=-p.x*sx+p.z*cx,y=p.y;
      const y2=y*cosT-z*sinT,z2=y*sinT+z*cosT;
      const sc=1/(1.6-z2*.5); /* perspektíva */
      return {sx:C+x*R*sc,sy:C+y2*R*sc,z:z2,sc,p};
    });
    ctx.lineWidth=.55;
    for(const [i,j,landLink] of links){
      const a=proj[i],b=proj[j];
      const vis=(a.z+b.z)/2; if(vis<-.15)continue;
      ctx.strokeStyle=landLink
        ?`rgba(43,224,166,${(.10+.30*(vis+.15))})`
        :`rgba(14,157,229,${(.05+.16*(vis+.15))})`;
      ctx.beginPath();ctx.moveTo(a.sx,a.sy);ctx.lineTo(b.sx,b.sy);ctx.stroke();
    }
    for(const q of proj){
      const front=(q.z+1)/2; /* 0 vzadu → 1 vpredu */
      const twinkle=.72+.28*Math.sin(t*.0016+q.p.tw);
      let al=((q.p.land?.18:.10)+(q.p.land?.82:.62)*front*front)*twinkle;
      /* vlna z kliknutia: rozjasní body, ktorými práve prechádza */
      let pk=0;
      for(const pu of pulses){
        const age=t-pu.t0;
        const d=Math.acos(Math.max(-1,Math.min(1,q.p.x*pu.p.x+q.p.y*pu.p.y+q.p.z*pu.p.z)));
        /* jemný lokálny záblesk pri bode kliku (bez vlny cez celú guľu), rýchlo zhasne */
        const g=Math.exp(-((d/.22)**2))*Math.max(0,1-age/650);
        if(g>pk)pk=g;
      }
      al=Math.min(1,al+pk*.7);
      ctx.fillStyle=q.p.land?`rgba(43,224,166,${al})`:`rgba(96,180,244,${al})`;
      ctx.beginPath();ctx.arc(q.sx,q.sy,q.p.sz*q.sc*(1+pk*1.1),0,7);ctx.fill();
      if(pk>.25){
        ctx.fillStyle=`rgba(200,255,236,${pk*.55})`;
        ctx.beginPath();ctx.arc(q.sx,q.sy,q.p.sz*q.sc*.6,0,7);ctx.fill();
      }
    }
  }
  if(reduced){frame(9000);}
  else{
    let running=true;
    new IntersectionObserver(es=>{running=es[0].isIntersecting},{threshold:0}).observe(globe);
    (function loop(t){if(running)frame(t);requestAnimationFrame(loop)})(0);
  }
}

/* particles „AI" v sekcii Služby – myš rozháňa, klik rozpráši (beží za kartami) */
(function(){
  const cv=document.getElementById('fx-ai');if(!cv)return;
  const host=document.getElementById('sluzby')||cv;
  const ctx=cv.getContext('2d');
  const dpr=Math.min(devicePixelRatio||1,2);
  const W=800,H=480;cv.width=W*dpr;cv.height=H*dpr;ctx.scale(dpr,dpr);
  /* rozloženie písmen AI na body */
  const off=document.createElement('canvas');off.width=W;off.height=H;
  const octx=off.getContext('2d');
  octx.font='900 370px Arial';octx.textAlign='center';octx.textBaseline='middle';
  octx.fillText('AI',W/2,H/2+20);
  const data=octx.getImageData(0,0,W,H).data;
  const pts=[];
  for(let y=2;y<H;y+=8)for(let x=2;x<W;x+=8){
    if(data[(y*W+x)*4+3]>128)pts.push({hx:x,hy:y,x:Math.random()*W,y:Math.random()*H,
      vx:0,vy:0,mint:Math.random()<.25,sz:1.6+Math.random()*1.8,tw:Math.random()*6.28});
  }
  const mouse={x:-9999,y:-9999};
  host.addEventListener('pointermove',e=>{const r=cv.getBoundingClientRect();mouse.x=(e.clientX-r.left)*W/r.width;mouse.y=(e.clientY-r.top)*H/r.height;});
  host.addEventListener('pointerleave',()=>{mouse.x=-9999;mouse.y=-9999;});
  host.addEventListener('click',e=>{if(e.target.closest('a,button'))return;for(const p of pts){const a=Math.random()*6.28,f=6+Math.random()*10;p.vx+=Math.cos(a)*f;p.vy+=Math.sin(a)*f;}});
  function frame(t){
    ctx.clearRect(0,0,W,H);
    for(const p of pts){
      p.vx+=(p.hx-p.x)*.02;p.vy+=(p.hy-p.y)*.02;
      const dx=p.x-mouse.x,dy=p.y-mouse.y,d2=dx*dx+dy*dy;
      if(d2<8100){const d=Math.sqrt(d2)||1,f=(90-d)*.09;p.vx+=dx/d*f;p.vy+=dy/d*f;}
      p.vx*=.9;p.vy*=.9;p.x+=p.vx;p.y+=p.vy;
      const al=.4+.6*Math.abs(Math.sin(t*.0015+p.tw));
      ctx.fillStyle=p.mint?`rgba(43,224,166,${al})`:`rgba(96,180,244,${al})`;
      ctx.beginPath();ctx.arc(p.x,p.y,p.sz,0,7);ctx.fill();
    }
  }
  if(reduced){pts.forEach(p=>{p.x=p.hx;p.y=p.hy});frame(900);return;}
  let running=true;
  new IntersectionObserver(es=>{running=es[0].isIntersecting},{threshold:0}).observe(cv);
  (function loop(t){if(running)frame(t);requestAnimationFrame(loop)})(0);
})();

/* svetelný proces v sekcii Prečo noGrey – pulzy tečú medzi uzlami, klik pridá pulz */
(function(){
  const cv=document.getElementById('fx-proc');if(!cv)return;
  const ctx=cv.getContext('2d');
  const dpr=Math.min(devicePixelRatio||1,2);
  const W=680,H=410;cv.width=W*dpr;cv.height=H*dpr;ctx.scale(dpr,dpr);
  const pt=t=>({x:56+568*t,y:205+Math.sin(t*Math.PI*2-.6)*58}); /* vlnená dráha */
  const nodes=[0,.33,.66,1].map(pt);
  const pulses=[{t:0},{t:.37},{t:.72}];
  /* ambientné častice */
  const amb=[];for(let i=0;i<120;i++)amb.push({x:Math.random()*W,y:Math.random()*H,
    vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,sz:.8+Math.random()*1.8,
    tw:Math.random()*6.28,mint:Math.random()<.3});
  /* plávajúce kódové tokeny */
  const TOK=['</>','{ }','=>','( )','01','<div>','fn()',';','&&','[ ]'];
  const glyphs=[];for(let i=0;i<14;i++)glyphs.push({tok:TOK[i%TOK.length],
    x:20+Math.random()*(W-70),y:Math.random()*H,v:.15+Math.random()*.28,
    sz:13+Math.random()*8,ph:Math.random()*6.28,mint:Math.random()<.4});
  const mouse={x:-9999,y:-9999};
  cv.addEventListener('pointermove',e=>{const r=cv.getBoundingClientRect();mouse.x=(e.clientX-r.left)*W/r.width;mouse.y=(e.clientY-r.top)*H/r.height;});
  cv.addEventListener('pointerleave',()=>{mouse.x=-9999;mouse.y=-9999;});
  cv.addEventListener('click',()=>{if(pulses.length<8)pulses.push({t:0});});
  let last=0;
  function frame(t){
    const dt=Math.min(t-last,50);last=t;
    ctx.clearRect(0,0,W,H);
    /* ambientné častice */
    for(const a of amb){
      a.x+=a.vx;a.y+=a.vy;
      if(a.x<0)a.x=W;if(a.x>W)a.x=0;if(a.y<0)a.y=H;if(a.y>H)a.y=0;
      const al=(.15+.45*Math.abs(Math.sin(t*.001+a.tw)));
      ctx.fillStyle=a.mint?`rgba(43,224,166,${al})`:`rgba(96,180,244,${al})`;
      ctx.beginPath();ctx.arc(a.x,a.y,a.sz,0,7);ctx.fill();
    }
    /* kódové tokeny stúpajú nahor */
    ctx.textAlign='left';
    for(const g of glyphs){
      g.y-=g.v;if(g.y<-16){g.y=H+14;g.x=20+Math.random()*(W-60);}
      const al=.2+.4*Math.abs(Math.sin(t*.0008+g.ph));
      ctx.font=`600 ${g.sz}px Consolas,monospace`;
      ctx.fillStyle=g.mint?`rgba(43,224,166,${al})`:`rgba(96,180,244,${al})`;
      ctx.fillText(g.tok,g.x,g.y);
    }
    /* dráha */
    ctx.strokeStyle='rgba(96,180,244,.22)';ctx.lineWidth=1.6;ctx.beginPath();
    for(let i=0;i<=60;i++){const q=pt(i/60);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);}
    ctx.stroke();
    /* pulzy s chvostom */
    for(const pu of pulses){
      pu.t=(pu.t+dt*.00012)%1;
      for(let k=0;k<7;k++){
        const q=pt(Math.max(0,pu.t-k*.012));
        ctx.fillStyle=`rgba(43,224,166,${(1-k/7)*.8})`;
        ctx.beginPath();ctx.arc(q.x,q.y,4.6-k*.5,0,7);ctx.fill();
      }
    }
    /* uzly – rozžiaria sa pri pulze aj pri myši */
    nodes.forEach((n,i)=>{
      let glow=0;
      for(const pu of pulses){const d=Math.abs(pu.t-i/3);glow=Math.max(glow,Math.max(0,1-d*9));}
      const md=Math.hypot(n.x-mouse.x,n.y-mouse.y);if(md<46)glow=Math.max(glow,.9);
      ctx.strokeStyle=`rgba(96,180,244,${.5+glow*.5})`;ctx.lineWidth=2.4;
      ctx.beginPath();ctx.arc(n.x,n.y,17+glow*6,0,7);ctx.stroke();
      ctx.fillStyle=`rgba(43,224,166,${.55+glow*.45})`;
      ctx.beginPath();ctx.arc(n.x,n.y,7+glow*3,0,7);ctx.fill();
      if(glow>.1){ctx.strokeStyle=`rgba(43,224,166,${glow*.35})`;ctx.lineWidth=1.2;
        ctx.beginPath();ctx.arc(n.x,n.y,28+glow*12,0,7);ctx.stroke();}
    });
  }
  if(reduced){frame(0);return;}
  let running=true;
  new IntersectionObserver(es=>{running=es[0].isIntersecting},{threshold:0}).observe(cv);
  (function loop(t){if(running)frame(t);requestAnimationFrame(loop)})(0);
})();

/* ambientné pozadové animácie sekcií – jemný skript / digital technology */
function sectionFx(id,o){
  const cv=document.getElementById(id);if(!cv)return;
  const ctx=cv.getContext('2d');
  const dpr=Math.min(devicePixelRatio||1,2);
  let W=0,H=0,dots=[],glyphs=[];
  function fit(){
    W=Math.max(1,cv.clientWidth);H=Math.max(1,cv.clientHeight);
    cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
    dots=[];for(let i=0;i<o.dots;i++)dots.push({x:Math.random()*W,y:Math.random()*H,
      vx:(Math.random()-.5)*.22,vy:(Math.random()-.5)*.22,sz:.9+Math.random()*1.7,tw:Math.random()*6.28});
    glyphs=[];for(let i=0;i<o.glyphCount;i++)glyphs.push({tok:o.toks[i%o.toks.length],
      x:20+Math.random()*Math.max(40,W-60),y:Math.random()*H,v:.1+Math.random()*.2,
      sz:11+Math.random()*7,ph:Math.random()*6.28});
  }
  fit();addEventListener('resize',fit);
  function frame(t){
    ctx.clearRect(0,0,W,H);
    if(o.links){
      for(let i=0;i<dots.length;i++)for(let j=i+1;j<dots.length;j++){
        const a=dots[i],b=dots[j],dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy;
        if(d2<12100){ctx.strokeStyle=o.line(Math.max(0,(1-Math.sqrt(d2)/110)*.14));
          ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
      }
    }
    for(const d of dots){
      d.x+=d.vx;d.y+=d.vy;
      if(d.x<0)d.x=W;if(d.x>W)d.x=0;if(d.y<0)d.y=H;if(d.y>H)d.y=0;
      ctx.fillStyle=o.dot(o.dotA[0]+o.dotA[1]*Math.abs(Math.sin(t*.001+d.tw)));
      ctx.beginPath();ctx.arc(d.x,d.y,d.sz,0,7);ctx.fill();
    }
    ctx.textAlign='left';
    for(const g of glyphs){
      g.y-=g.v;if(g.y<-16){g.y=H+14;g.x=20+Math.random()*Math.max(40,W-60);}
      ctx.font=`600 ${g.sz}px Consolas,monospace`;
      ctx.fillStyle=o.glyph(o.glyphA[0]+o.glyphA[1]*Math.abs(Math.sin(t*.0008+g.ph)));
      ctx.fillText(g.tok,g.x,g.y);
    }
  }
  if(reduced){frame(700);return;}
  let running=true;
  new IntersectionObserver(es=>{running=es[0].isIntersecting},{threshold:0}).observe(cv);
  (function loop(t){if(running)frame(t);requestAnimationFrame(loop)})(0);
}
/* svetlá sekcia „Váš biznis" – jemne sivý skript */
sectionFx('fx-biznis',{dots:48,dotA:[.08,.10],dot:a=>`rgba(11,18,32,${a})`,
  glyphCount:8,glyphA:[.09,.12],glyph:a=>`rgba(55,70,88,${a})`,
  toks:['</>','{ }','=>','( )','01',';'],links:false});
/* tmavá sekcia „Ako pracujeme" – digital technology v tmavomodrej */
sectionFx('fx-tech',{dots:64,dotA:[.10,.16],dot:a=>`rgba(70,140,210,${a})`,
  glyphCount:9,glyphA:[.07,.11],glyph:a=>`rgba(70,140,210,${a})`,
  toks:['01','10','0110','</>','{ }','AI'],links:true,line:a=>`rgba(45,110,180,${a})`});

/* plynulé otváranie/zatváranie FAQ (details/summary) */
if(!reduced){
  document.querySelectorAll('details').forEach(details=>{
    const summary=details.querySelector('summary');
    const content=details.querySelector('p');
    if(!content)return;
    let anim=null,closing=false,expanding=false;
    summary.addEventListener('click',e=>{
      e.preventDefault();
      details.style.overflow='hidden';
      if(closing||!details.open)openIt();else if(expanding||details.open)shrink();
    });
    function shrink(){
      closing=true;
      const startH=details.offsetHeight+'px',endH=summary.offsetHeight+'px';
      if(anim)anim.cancel();
      anim=details.animate({height:[startH,endH]},{duration:220,easing:'ease-out'});
      anim.onfinish=()=>onFinish(false);
      anim.oncancel=()=>closing=false;
    }
    function openIt(){
      details.style.height=details.offsetHeight+'px';
      details.open=true;
      requestAnimationFrame(expand);
    }
    function expand(){
      expanding=true;
      const startH=details.offsetHeight+'px',endH=(summary.offsetHeight+content.offsetHeight)+'px';
      if(anim)anim.cancel();
      anim=details.animate({height:[startH,endH]},{duration:220,easing:'ease-out'});
      anim.onfinish=()=>onFinish(true);
      anim.oncancel=()=>expanding=false;
    }
    function onFinish(isOpen){
      details.open=isOpen;anim=null;closing=false;expanding=false;
      details.style.height=details.style.overflow='';
    }
  });
}

/* načítavanie čísel v intre (count-up) */
const counters=document.querySelectorAll('.count');
if(counters.length){
  const ease=t=>1-Math.pow(1-t,3); /* easeOutCubic */
  counters.forEach(el=>{
    const to=parseInt(el.dataset.to,10);
    if(reduced){el.textContent=String(to);return;}
    const dur=parseInt(el.dataset.dur||'1400',10);
    const t0=performance.now();
    (function tick(now){
      const p=Math.min((now-t0)/dur,1);
      el.textContent=String(Math.round(to*ease(p)));
      if(p<1)requestAnimationFrame(tick);
    })(t0);
  });
}
