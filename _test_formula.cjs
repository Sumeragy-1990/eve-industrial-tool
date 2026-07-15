const ev={T:4540536,P:2270268,MX:340541,I:113514,N:13622,Z:3406,MG:1703,CR:1,LS:66,AI:131};
const me=10,b=0.03;
for(const[n,e]of Object.entries(ev)){
  var ok=false;
  for(var x=Math.max(1,e-200000);x<e;x++){
    if(Math.ceil(x + x*0.1/(1+me)*(1-b))===e){console.log('OK',n,'base='+x);ok=true;break;}
  }
  if(!ok)console.log('FAIL',n,'eve='+e);
}
