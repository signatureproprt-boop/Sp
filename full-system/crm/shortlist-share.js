(function(root){
'use strict';
const has=v=>v!==null&&v!==undefined&&v!=='';
const builder=v=>!v||/unknown/i.test(v)||String(v).length>55||/[.!]/.test(v)?'':String(v);
function matchesLayout(c,f){const n=Number(String(c.BHK||c.Type||'').match(/\d+/)?.[0]);return (!f.bhk||n===Number(String(f.bhk).match(/\d+/)?.[0]))&&(!f.carpetMin||(has(c.CarpetAreaSqft)&&Number(c.CarpetAreaSqft)>=Number(f.carpetMin)))&&(!f.carpetMax||(has(c.CarpetAreaSqft)&&Number(c.CarpetAreaSqft)<=Number(f.carpetMax)));}
const bhk=v=>has(v)?(/bhk/i.test(String(v))?String(v):`${v} BHK`):'';
function phone(p={}){let n=String(p.WhatsApp||p.PrimaryMobile||p.Phone||'').replace(/\D/g,'');if(n.length===11&&n[0]==='0')n=n.slice(1);if(n.length===10)n='91'+n;return /^[1-9]\d{9,14}$/.test(n)?n:'';}
function layout(c){return [c.Tower&&`Tower ${c.Tower}`,c.FlatType,/bhk/i.test(c.Type||'')?c.Type:[c.Type,bhk(c.BHK)].filter(Boolean).join(' · '),has(c.CarpetAreaSqft)&&`Carpet: ${c.CarpetAreaSqft} sqft`,has(c.SuperBuiltUpAreaSqft)&&`Super built-up: ${c.SuperBuiltUpAreaSqft} sqft`,has(c.TerraceAreaSqft)&&`Terrace: ${c.TerraceAreaSqft} sqft`].filter(Boolean).join(' · ');}
function message(rows,lead={},origin){const lines=['*SIGNATURE PROPERTIES*',`Dear ${lead.ClientName||lead.Name||'Client'},`,'Please find the property options selected for your requirement.',''];
rows.forEach((r,i)=>{const p=r.Property||{};lines.push(`*${i+1}. ${p.Title||p.ProjectName||r.PropertyID}*`);lines.push(...[builder(p.BuilderName)&&`Builder: ${builder(p.BuilderName)}`,[p.Location1,p.SocietyName].filter(Boolean).join(' · '),[p.Category,p.SubCategory,p.ListingFor].filter(Boolean).join(' · ')].filter(Boolean));
if(p.ConfigDetails?.length)lines.push('Configuration (subject to availability):',...p.ConfigDetails.map(layout).filter(Boolean));else{if(p.BHK)lines.push(bhk(p.BHK));if(has(p.CarpetArea))lines.push(`Carpet: ${p.CarpetArea} sqft`);if(has(p.SuperBuiltUpAreaSqft))lines.push(`Super built-up: ${p.SuperBuiltUpAreaSqft} sqft`);if(!has(p.CarpetArea)&&has(p.Area))lines.push(`Area: ${p.Area} sqft (area type not specified)`);}
lines.push(p.AskingPrice&&Number.isFinite(Number(p.AskingPrice))?`Asking price: ₹${Number(p.AskingPrice).toLocaleString('en-IN')}${/^rent|^lease/i.test(p.ListingFor||'')?'/month':''}`:'Price: on request');if(p.AskingRatePerSqFt)lines.push(`Rate: ₹${Number(p.AskingRatePerSqFt).toLocaleString('en-IN')}/sqft`);if(p.FurnishingType)lines.push(`Furnishing: ${p.FurnishingType}`);if(p.Status)lines.push(`Status: ${p.Status}`);if(p.RERANumber)lines.push(`RERA: ${p.RERANumber}`);
for(const [key,label] of [['brochures','Brochure'],['photos','Photo'],['videos','Video']]){const urls=[...new Set((p.MediaLinks?.[key]||[]).map(v=>{try{const u=new URL(v,origin);return /^https?:$/.test(u.protocol)?u.href:null;}catch(_){return null;}}).filter(Boolean))];urls.forEach(u=>lines.push(`${label}: ${u}`));}lines.push('');});
lines.push('Please reply with your preferred option to arrange a site visit. Price and availability are subject to confirmation.','— Signature Properties');return lines.join('\n');}
async function renderCards(root,rows,lead={}) {
  root.replaceChildren();
  const logo=new Image();logo.src='/assets/signature-mark.svg';
  await new Promise((resolve,reject)=>{logo.onload=resolve;logo.onerror=()=>reject(new Error('Firm logo could not be loaded. Please retry.'));});
  for(const [index,row] of rows.entries()) {
    const p=row.Property || {},canvas=document.createElement('canvas');canvas.width=1080;
    const ctx=canvas.getContext('2d'),lines=[];
    const add=(text)=>{if(!text)return;ctx.font='26px Arial';let line='';for(const word of String(text).split(/\s+/)){if(ctx.measureText(line+' '+word).width>900){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);};
    add(p.Title || p.ProjectName || row.PropertyID);add(builder(p.BuilderName));add([p.Location1,p.Category].filter(Boolean).join(' | '));
    if(p.ConfigDetails?.length)p.ConfigDetails.forEach(c=>add(layout(c)));
    else {add(bhk(p.BHK));if(has(p.CarpetArea))add('Carpet: '+p.CarpetArea+' sqft');if(has(p.SuperBuiltUpAreaSqft))add('Super built-up: '+p.SuperBuiltUpAreaSqft+' sqft');}
    add(p.AskingPrice?'Asking price: ₹'+Number(p.AskingPrice).toLocaleString('en-IN'):'Price on request');add(p.Status);
    canvas.height=450+lines.length*48;ctx.fillStyle='#faf7f1';ctx.fillRect(0,0,1080,canvas.height);ctx.fillStyle='#2c1b12';ctx.fillRect(0,0,1080,185);ctx.drawImage(logo,50,47,88,88);ctx.fillStyle='#fff';ctx.font='bold 36px Arial';ctx.fillText('SIGNATURE PROPERTIES',165,94);ctx.font='22px Arial';ctx.fillStyle='#dcc6a4';ctx.fillText('CURATED PROPERTY SHORTLIST',165,133);
    ctx.fillStyle='#8a6a43';ctx.font='22px Arial';ctx.fillText('OPTION '+(index+1),60,240);
    lines.forEach((line,i)=>{ctx.fillStyle=i===0?'#2c1b12':'#594d42';ctx.font=i===0?'bold 30px Arial':'26px Arial';ctx.fillText(line,60,300+i*48);});
    ctx.strokeStyle='#d8cbb9';ctx.beginPath();ctx.moveTo(60,canvas.height-120);ctx.lineTo(1020,canvas.height-120);ctx.stroke();ctx.fillStyle='#75654f';ctx.font='21px Arial';ctx.fillText('Contact Signature Properties to arrange a site visit.',60,canvas.height-75);ctx.fillText('Price and availability subject to confirmation.',60,canvas.height-40);
    const image=document.createElement('img');image.src=canvas.toDataURL('image/png');image.alt='Signature Properties — '+(p.Title||'Property')+' shortlist card';image.style.cssText='width:100%;max-width:520px;display:block;border-radius:12px;margin:12px 0';root.append(image);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const file=new File([blob],'signature-properties-option-'+(index+1)+'.png',{type:'image/png'});
    const download=document.createElement('a');download.href=URL.createObjectURL(blob);download.download=file.name;download.textContent='Download branded card';download.className='btn btn-ghost';root.append(download);
    const share=document.createElement('button');share.textContent='Share card';share.className='btn btn-primary';share.onclick=async()=>{try{if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:'Signature Properties',text:'Selected property details. Please contact us to arrange a site visit.'});else download.click();}catch(e){if(e.name!=='AbortError')alert('Could not share card. Use Download branded card.');}};root.append(share);
  }
}
const api={phone,message,layout,builder,matchesLayout,renderCards};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ShortlistShare=api;
})(typeof window!=='undefined'?window:this);
