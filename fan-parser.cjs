const fs=require('fs');
function parseFan(path){
 const bytes=fs.readFileSync(path);const rows=bytes.toString('latin1').split(/\r?\n/).filter(Boolean);
 const out=new Map();
 for(const line of rows){
  const b=Buffer.from(line,'latin1');if(b.length!==416)throw Error('固定長416バイトではありません: '+b.length);
  let p=0;const field=n=>{const v=b.subarray(p,p+n).toString('ascii').trim();p+=n;return v};
  const number=n=>{const v=field(n);return /^\d+$/.test(v)?Number(v):null};
  const id=field(4);p+=16+15+4;const grade=field(2);p+=1+6+1+2+3+2+2;
  const win=number(4),two=number(4),first=number(3),second=number(3),starts=number(3);p+=2+2;
  const st=number(3);p+=6*(3+4+3+3);p+=2+2+2+4+4+4+1;
  const from=field(8),to=field(8);p+=3;
  let third=0,f=0,l=0,oneSum=0,twoSum=0;
  for(let c=0;c<6;c++){
   const positions=Array.from({length:6},()=>number(3));oneSum+=positions[0]||0;twoSum+=positions[1]||0;third+=positions[2]||0;
   f+=number(2)||0;l+=(number(2)||0)+(number(2)||0);p+=2*5;
  }
  l+=(number(2)||0)+(number(2)||0);
  if(p!==406)throw Error('解析位置不正 '+p);
  if(!/^\d{4}$/.test(id)||oneSum!==first||twoSum!==second)throw Error('着順回数照合不一致 '+id);
  const three=starts?Math.round((first+second+third)/starts*1000)/10:null;
  out.set(id,{registration:id,grade,winRate:win===null?null:win/100,twoRate:two===null?null:two/10,threeRate:three,avgST:st===null?null:st/100,starts,first,second,third,F:f,L:l,periodFrom:from,periodTo:to});
 }
 return out;
}
module.exports={parseFan};
