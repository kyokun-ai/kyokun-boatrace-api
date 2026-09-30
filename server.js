import express from 'express';
import * as cheerio from 'cheerio';
const app=express();
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin','*');next();});
app.get('/',(req,res)=>res.json({ok:true,name:'Kyokun BOATRACE API v0.1'}));
app.get('/api/race',async(req,res)=>{
 const {date,jcd,rno}=req.query;
 if(!/^\d{8}$/.test(date||'')||!/^\d{2}$/.test(jcd||'')||!/^(?:[1-9]|1[0-2])$/.test(rno||'')) return res.status(400).json({ok:false,error:'date(YYYYMMDD), jcd(01-24), rno(1-12) are required'});
 const url=`https://www.boatrace.jp/owpc/pc/race/racelist?hd=${date}&jcd=${jcd}&rno=${rno}`;
 try{
  const rr=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 KyokunResearch/0.1','accept-language':'ja,en;q=0.8'}});
  if(!rr.ok) throw new Error(`official HTTP ${rr.status}`);
  const html=await rr.text(); const $=cheerio.load(html);
  const text=$('body').text().replace(/\u3000/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n');
  // Robust v0.1: expose official text plus best-effort racer extraction. Parser will be tightened after live deployment test.
  const racers=[];
  $('table tbody tr').each((_,tr)=>{
   const t=$(tr).text().replace(/\s+/g,' ').trim();
   const reg=t.match(/\b(\d{4})\b/); const rank=t.match(/\b(A1|A2|B1|B2)\b/);
   if(reg&&rank&&racers.length<6) racers.push({registration:reg[1],rank:rank[1],raw:t});
  });
  res.json({ok:true,source:url,date,jcd,rno:Number(rno),racers,officialText:text.slice(0,30000)});
 }catch(e){res.status(502).json({ok:false,error:String(e.message||e),source:url});}
});
const port=process.env.PORT||3000; app.listen(port,()=>console.log(`Kyokun API on ${port}`));
