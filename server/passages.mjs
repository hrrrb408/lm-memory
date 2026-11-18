// Overlapping character windows bound the input before model token truncation.
// Parent records remain the unit of returned evidence and lifecycle control.
export function passageWindows(text,size=384,overlap=64){
 if(size<=overlap||overlap<0)throw new Error('Invalid passage window');
 const chars=Array.from(String(text)),out=[];
 for(let start=0;start<chars.length;start+=size-overlap){out.push(chars.slice(start,start+size).join(''));if(start+size>=chars.length)break;}
 return out;
}
