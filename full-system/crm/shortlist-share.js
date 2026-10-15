(function(root){
'use strict';
const has=v=>v!==null&&v!==undefined&&v!=='';
const bhk=v=>has(v)?(/bhk/i.test(String(v))?String(v):`${v} BHK`):'';
function phone(p={}){let n=String(p.WhatsApp||p.PrimaryMobile||p.Phone||'').replace(/\D/g,'');if(n.length===11&&n[0]==='0')n=n.slice(1);if(n.length===10)n='91'+n;return /^[1-9]\d{9,14}$/.test(n)?n:'';}
function layout(c){return [c.Tower&&`Tower ${c.Tower}`,c.FlatType,/bhk/i.test(c.Type||'')?c.Type:[c.Type,bhk(c.BHK)].filter(Boolean).join(' · '),has(c.CarpetAreaSqft)&&`Carpet: ${c.CarpetAreaSqft} sqft`,has(c.SuperBuiltUpAreaSqft)&&`Super built-up: ${c.SuperBuiltUpAreaSqft} sqft`,has(c.TerraceAreaSqft)&&`Terrace: ${c.TerraceAreaSqft} sqft`].filter(Boolean).join(' · ');}
function message(rows,lead={},origin){const lines=['🏠 *Signature Properties*',`Hi ${lead.ClientName||lead.Name||'Client'},`,'Aapke liye shortlisted options:',''];
rows.forEach((r,i)=>{const p=r.Property||{};lines.push(`*${i+1}. ${p.Title||p.ProjectName||r.PropertyID}*`);lines.push(...[p.BuilderName&&`Builder: ${p.BuilderName}`,[p.Location1,p.SocietyName].filter(Boolean).join(' · '),[p.Category,p.SubCategory,p.ListingFor].filter(Boolean).join(' · ')].filter(Boolean));
if(p.ConfigDetails?.length)lines.push('Project configurations (unit availability to be confirmed):',...p.ConfigDetails.map(layout).filter(Boolean));else{if(p.BHK)lines.push(bhk(p.BHK));if(has(p.CarpetArea))lines.push(`Carpet: ${p.CarpetArea} sqft`);if(has(p.SuperBuiltUpAreaSqft))lines.push(`Super built-up: ${p.SuperBuiltUpAreaSqft} sqft`);if(!has(p.CarpetArea)&&has(p.Area))lines.push(`Area: ${p.Area} sqft (area type not specified)`);}
lines.push(p.AskingPrice&&Number.isFinite(Number(p.AskingPrice))?`Asking price: ₹${Number(p.AskingPrice).toLocaleString('en-IN')}${/^rent|^lease/i.test(p.ListingFor||'')?'/month':''}`:'Price: on request');if(p.AskingRatePerSqFt)lines.push(`Rate: ₹${Number(p.AskingRatePerSqFt).toLocaleString('en-IN')}/sqft`);if(p.FurnishingType)lines.push(`Furnishing: ${p.FurnishingType}`);if(p.Status)lines.push(`Status: ${p.Status}`);if(p.RERANumber)lines.push(`RERA: ${p.RERANumber}`);
for(const [key,label] of [['brochures','Brochure'],['photos','Photo'],['videos','Video']]){const urls=[...new Set((p.MediaLinks?.[key]||[]).map(v=>{try{const u=new URL(v,origin);return /^https?:$/.test(u.protocol)?u.href:null;}catch(_){return null;}}).filter(Boolean))];urls.forEach(u=>lines.push(`${label}: ${u}`));}lines.push('');});
lines.push('Pasand aaye option ka number reply karein. Price, availability aur site visit confirm karwa denge.','— Signature Properties');return lines.join('\n');}
const api={phone,message};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ShortlistShare=api;
})(typeof window!=='undefined'?window:this);
