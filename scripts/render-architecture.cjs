const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs/architecture');
const diagrams = path.join(dir, 'diagrams');
fs.mkdirSync(diagrams, { recursive: true });
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function text(x,y,s,size=18,color='#23433d',weight=400,anchor='start') { return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`; }
function box(x,y,w,h,title,lines=[],tone='green') {
  const bg = tone === 'gold' ? '#fff1d6' : tone === 'gray' ? '#edf0f2' : '#e7f2ed';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${bg}" stroke="#9eb8ad"/>` + text(x+18,y+31,title,20,'#173b35',650) + lines.map((s,i)=>text(x+18,y+60+i*25,s,16)).join('');
}
function line(x1,y1,x2,y2,label='',dashed=false) { return `<path d="M${x1},${y1} L${x2},${y2}" stroke="#557e70" stroke-width="2" fill="none" ${dashed?'stroke-dasharray="7 5"':''} marker-end="url(#arrow)"/>`+(label?text((x1+x2)/2,(y1+y2)/2-10,label,15,'#46574f',500,'middle'):''); }
function svg(name,title,subtitle,h,body) {
  const contents = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${h}" viewBox="0 0 1200 ${h}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(subtitle)}</desc><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse"><path d="M0,0 L9,4.5 L0,9" fill="#557e70"/></marker></defs><rect width="1200" height="${h}" rx="18" fill="#fcfbf7"/><g font-family="Segoe UI,Arial,sans-serif">${text(32,43,title,27,'#173b35',700)}${text(32,73,subtitle,16,'#63736b')}${body}${text(32,h-18,'IP Messenger • repository study • 22 September 2026',12,'#7b857e')}</g></svg>`;
  const uniqueContents = contents.replaceAll('id="title"', `id="${name}-title"`).replaceAll('id="desc"', `id="${name}-desc"`).replaceAll('id="arrow"', `id="${name}-arrow"`).replaceAll('aria-labelledby="title desc"', `aria-labelledby="${name}-title ${name}-desc"`).replaceAll('url(#arrow)', `url(#${name}-arrow)`);
  fs.writeFileSync(path.join(diagrams,name+'.svg'),uniqueContents);
}
svg('01-system','01 / System context','Active peers communicate directly. Other implementations are separate products in the same repository.',620,
  box(35,120,380,190,'Android phone / Expo',['React Native UI + MobileRuntime','Shared TypeScript domain services','Native TCP + UDP + platform storage','Both client and listening server'])+
  box(785,120,380,190,'Windows PC / WPF',['XAML UI + C# PeerService','.NET sockets and cryptography','JSON history + DPAPI-protected keys','Both client and listening server'])+
  line(425,180,775,180,'UDP 5051 / discovery',true)+line(775,250,425,250,'TCP 5050 / JSON + encrypted content')+
  box(35,395,530,140,'Electron prototype',['React DOM + Node sockets + IPC bridge','Shared TypeScript; sample discovery'],'gray')+
  box(635,395,530,140,'Flutter prototype',['Dart / Material UI + SQLite','Sample devices; local chat persistence'],'gray')+
  text(600,352,'No central server, cloud queue or internet relay in the active path',19,'#173b35',600,'middle'));
svg('02-components','02 / Process components','Code sharing stops at TypeScript; Windows interoperates through the protocol, not a JavaScript runtime.',770,
  box(35,115,520,105,'Mobile UI / App.tsx',['Hooks, selected peer, pairing input, chat, transfer controls'])+
  box(645,115,520,105,'Windows UI / MainWindow',['XAML templates, code-behind, Dispatcher, tray'])+
  line(295,225,295,260)+line(905,225,905,260)+
  box(35,270,520,135,'MobileRuntime',['PairingCoordinator + MessageService','FileTransferService + LocalPeerConnectionManager','Events produce immutable UI snapshots'])+
  box(645,270,520,135,'PeerService + PeerService.Files',['C# pairing, messages, transfers and maintenance','Concurrent dictionaries, semaphores, cancellation','Events produce UI collection snapshots'])+
  line(295,410,295,455)+line(905,410,905,455)+
  box(35,465,520,160,'Platform adapters',['MobileSocket / react-native-tcp-socket','LanDiscovery / react-native-udp','Noble + expo-crypto; SecureStore + AsyncStorage'])+
  box(645,465,520,160,'Built-in .NET / Windows APIs',['TcpClient / TcpListener / UdpClient','ECDiffieHellman / AesGcm / SHA256','System.Text.Json / file APIs / ProtectedData'])+
  text(600,692,'Common contract: UTF-8 JSON + LF, event payloads, JWK keys, AES-GCM bytes',20,'#173b35',600,'middle'));
svg('03-discovery','03 / Discovery and emulator routes','A discovery sighting is a reachability hint, not an authenticated identity.',710,
  box(35,120,350,175,'Phone broadcasts',['Destination: 255.255.255.255:5051','JSON: service, version, ID, name,','platform and TCP port','Every 5 seconds'])+
  box(815,120,350,175,'PC receives / advertises',['Use UDP source address as peer IP','Validate datagram and update list','16-second nearby window','Connect to advertised TCP port'])+
  line(395,180,805,180,'UDP broadcast on the same LAN',true)+line(805,250,395,250,'Both devices advertise',true)+
  box(35,390,530,190,'Emulator → desktop',['Mobile manual address: 10.0.2.2:5050','Emulator virtual gateway routes to host TCP','Ordinary LAN broadcasts may not cross NAT','Physical phone uses actual PC Wi-Fi IPv4'],'gold')+
  box(635,390,530,190,'Desktop → emulator',['adb forward tcp:15050 tcp:5050','Desktop manual address: 127.0.0.1:15050','ADB routes host port to emulator listener','Forwarding is test infrastructure, not app code'],'gold')+
  text(600,640,'Firewall, guest-network isolation and Wi-Fi filtering can prevent discovery or connection',18,'#63736b',500,'middle'));
function sequence(name,title,subtitle,participants,steps) {
  const xs=participants.length===2?[260,940]:[185,600,1015]; const h=190+steps.length*87;
  let b=''; participants.forEach((p,i)=>{ b+=box(xs[i]-150,102,300,63,p,[]); b+=`<line x1="${xs[i]}" y1="170" x2="${xs[i]}" y2="${h-45}" stroke="#aebdb4" stroke-dasharray="5 5"/>`; });
  steps.forEach(([from,to,label,note],i)=>{const y=210+i*87; if(from===to){b+=`<rect x="${xs[from]-170}" y="${y-22}" width="340" height="57" rx="7" fill="#fff1d6"/>`+text(xs[from],y,label,16,'#173b35',600,'middle')+text(xs[from],y+22,note||'',13,'#63736b',400,'middle');} else { b+=line(xs[from],y+22,xs[to],y+22)+text((xs[from]+xs[to])/2,y,label,17,'#173b35',600,'middle')+text((xs[from]+xs[to])/2,y+46,note||'',14,'#63736b',400,'middle'); }});
  svg(name,title,subtitle,h,b);
}
sequence('04-pairing','04 / Pairing sequence','Simplified after TCP handshake. Manual approval is not a complete authenticated-channel protocol.', ['Initiating device','Receiving device'],[
  [0,0,'Generate P-256 pair + six-digit code','Fingerprint = SHA-256 of public JWK JSON'],
  [0,1,'PAIR_REQUEST','Code, identity, public key and fingerprint are plaintext'],
  [1,1,'User compares fingerprint and types code','Explicit consent; decline sends PAIR_REJECT'],
  [1,1,'Generate key pair; derive raw secret','32-byte ECDH X coordinate → AES key'],
  [1,0,'PAIR_ACCEPT','Responder public key/fingerprint and echoed code'],
  [0,0,'Validate pending response; derive same key','No HKDF, ratchet or fresh reconnect exchange'],
  [0,1,'Encrypted messages and file chunks','AES-256-GCM • random 12-byte IV • appended 16-byte tag'],
  [1,1,'Persist key for later connections','SecureStore on mobile; DPAPI on Windows']]);
sequence('05-messages','05 / Message delivery','Socket write, recipient delivery and UI read state are different milestones.', ['Sender UI / store','TCP connection','Receiver UI / store'],[
  [0,0,'Create message → queued','Trim text; assign ID; persist locally'],
  [0,1,'MESSAGE: encrypted body','queued → sending → sent on socket write'],
  [1,2,'Validate identity, decrypt and deduplicate','Store plaintext history; display incoming message'],
  [2,0,'MESSAGE_ACK','Sender state becomes delivered'],
  [2,2,'Selected conversation marks message read','App/UI state, not proof of human comprehension'],
  [2,0,'MESSAGE_READ','Sender state becomes read'],
  [0,0,'Retry queued messages on reconnect','Lost ACK recovery differs between mobile and WPF']]);
sequence('06-files','06 / File transfer','Example: 156,000 bytes = four chunks; all content is buffered in memory in the current implementation.', ['Sending device','Receiving device'],[
  [0,0,'Pick file; read bytes; SHA-256','Maximum 10 MiB; chunks of 49,152 bytes'],
  [0,1,'FILE_OFFER','Name, MIME, size, count, chunkSize and hash'],
  [1,1,'User chooses Accept / Decline','No file bytes should flow before acceptance'],
  [1,0,'FILE_ACCEPT','resumeFromChunk = 0'],
  [0,1,'FILE_CHUNK × N','Binary → base64 text → AES-GCM → base64 ciphertext'],
  [1,1,'Decrypt each chunk; validate size and hash','Retain chunks; update progress'],
  [0,1,'FILE_COMPLETE','End of content with whole-file SHA-256'],
  [1,1,'Reassemble and verify whole file','Windows saves before ACK; mobile save is async'],
  [1,0,'FILE_COMPLETE acknowledgement','Sender now marks completed'],
  [0,1,'Alternative: REJECT / CANCEL / ERROR','Inactivity timeout: 60 seconds; resend interrupted file']]);
svg('07-storage','07 / Persistence and trust boundaries','Encrypted transport content does not imply encrypted local message history.',680,
  box(35,115,530,155,'Mobile / protected small values',['SecureStore: stable profile','Trusted peers and base64 session keys','OS-backed protection; not a message database'])+
  box(635,115,530,155,'Windows / protected key bytes',['TrustedPeer.ProtectedKey in state.json','ProtectedData with CurrentUser scope','Only session-key bytes receive DPAPI protection'])+
  box(35,315,530,190,'Mobile / plaintext local data',['AsyncStorage: messages and transfer metadata','AsyncStorage: transfer ID → received URI','Documents/received: saved file bytes','System share sheet exports user-selected files'],'gold')+
  box(635,315,530,190,'Windows / plaintext local data',['LocalAppData/IPMessenger/state.json','Messages, peers and transfer history','LocalAppData/IPMessenger/Received: file bytes','Explorer action reveals the received file'],'gold')+
  text(600,565,'Electron prototype: localStorage also holds session keys without an OS-secret adapter',17,'#63736b',400,'middle')+
  text(600,603,'Flutter prototype: SQLite peer_messages.db; independent data model',17,'#63736b',400,'middle'));
svg('08-builds','08 / From source to executable','Build-time tooling is separate from runtime network communication.',900,
  box(35,115,530,110,'Windows source',['C# + XAML + SDK-style .csproj','Target: net10.0-windows / win-x64'])+
  box(635,115,530,110,'Android source',['TypeScript + React Native + Expo app.json','Native Kotlin project generated by Expo prebuild'])+
  line(300,232,300,265)+line(900,232,900,265)+
  box(35,275,530,130,'.NET SDK / MSBuild',['Compile C# and XAML resources','Framework references: WPF + Windows Forms','No declared third-party NuGet PackageReference'])+
  box(635,275,530,130,'Metro + Babel + Hermes',['Resolve mobile entry and shared workspaces','Bundle JavaScript; compile Hermes bytecode','Autolink native TCP, UDP, storage and file modules'])+
  line(300,410,300,445)+line(900,410,900,445)+
  box(35,455,530,140,'dotnet publish',['Release + self-contained + single-file','Bundle managed app + Windows desktop runtime','Native libraries may extract when launched'])+
  box(635,455,530,140,'Gradle + Android toolchain',['Kotlin/Java → DEX; C++ via NDK/CMake','Merge manifest/resources; release checks','Package and sign test APK'])+
  line(300,600,300,635)+line(900,600,900,635)+
  box(35,645,530,150,'IPMessenger.exe',['apps/windows-native/publish','Runs without Node, Electron or Metro','Windows x64; not NativeAOT'])+
  box(635,645,530,150,'IP-Messenger-1.0.0-android.apk',['.artifacts / approximately 35.2 MiB','arm64-v8a + x86_64; minimum Android API 24','Embedded bundle; test-key signed; no Metro needed']));

const markdown=fs.readFileSync(path.join(dir,'ARCHITECTURE-STUDY.md'),'utf8');
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function inline(s) {
  const tokens=[];
  const stash=html=>{const i=tokens.push(html)-1;return `\u0001${i}\u0001`;};
  s=s.replace(/`([^`]+)`/g,(_,v)=>stash(`<code>${esc(v)}</code>`));
  s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,v,u)=>stash(`<a href="${esc(u)}">${esc(v)}</a>`));
  s=esc(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  return s.replace(/\u0001(\d+)\u0001/g,(_,n)=>tokens[n]);
}
let html='', toc=[], openSection=false;
const lines=markdown.split(/\r?\n/);
for(let i=0;i<lines.length;){
  const s=lines[i];
  if(!s.trim()){i++;continue;}
  if(s.startsWith('```')){const lang=s.slice(3);const body=[];i++;while(i<lines.length&&!lines[i].startsWith('```'))body.push(lines[i++]);i++;html+=`<pre data-language="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`;continue;}
  const heading=s.match(/^(#{1,3}) (.+)$/);
  if(heading){const level=heading[1].length,id=slug(heading[2]);if(level===2){if(openSection)html+='</section>';openSection=true;html+=`<section class="study-section" id="${id}">`;toc.push([id,heading[2]]);}html+=`<h${level}${level!==2?` id="${id}"`:''}>${inline(heading[2])}</h${level}>`;i++;continue;}
  const img=s.match(/^!\[([^\]]+)\]\(([^)]+)\)$/);
  if(img){html+=`<figure>${fs.readFileSync(path.join(dir,img[2]),'utf8')}<figcaption>${esc(img[1])} · <a href="${esc(img[2])}">Open SVG</a></figcaption></figure>`;i++;continue;}
  if(s.startsWith('|')){const rows=[];while(i<lines.length&&lines[i].startsWith('|')){rows.push(lines[i++].split('|').slice(1,-1).map(t=>t.trim()));}html+='<div class="table-scroll"><table><thead><tr>'+rows[0].map(v=>'<th>'+inline(v)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(2).map(row=>'<tr>'+row.map(v=>'<td>'+inline(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';continue;}
  if(/^\d+\. /.test(s)){let items=[];while(i<lines.length&&/^\d+\. /.test(lines[i]))items.push(lines[i++].replace(/^\d+\. /,''));html+='<ol>'+items.map(v=>'<li>'+inline(v)+'</li>').join('')+'</ol>';continue;}
  const p=[];while(i<lines.length&&lines[i].trim()&&!/^(#|\||```|!\[|\d+\. )/.test(lines[i]))p.push(lines[i++]);html+='<p>'+inline(p.join(' '))+'</p>';
}
if(openSection)html+='</section>';
const inventory=JSON.parse(fs.readFileSync(path.join(dir,'dependencies.json'),'utf8'));
const dataset=inventory.npm.map(({name,version,location,installed,developmentOnly,optional,description,license,requestedBy})=>({name,version,location,installed,developmentOnly,optional,description,license,requestedBy}));
const appendix=`<section id="dependency-explorer"><h2>Search the complete npm dependency inventory</h2><p>All ${dataset.length} lockfile package-location entries. Descriptions are package metadata; parent links explain inclusion. This is not a list of only packages shipped in the APK.</p><label for="dependency-search">Package, version, purpose or requesting parent</label><input id="dependency-search" type="search" placeholder="Try tcp, crypto, expo, babel or a version…"><p id="result-count" role="status"></p><div id="dependency-results"></div><p><a href="npm-dependencies.csv">Download full npm CSV</a> · <a href="flutter-dependencies.csv">Flutter CSV</a> · <a href="dependencies.json">Complete JSON</a> · <a href="declared-dependencies.md">Direct declarations</a></p></section>`;
const content=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IP Messenger — Architecture study</title><style>
:root{color-scheme:light;--green:#173b35;--paper:#fcfbf7;--ink:#24352e}*{box-sizing:border-box}body{margin:0;background:#f0eee7;color:var(--ink);font:16px/1.7 system-ui,Segoe UI,sans-serif}aside{position:fixed;inset:0 auto 0 0;width:280px;background:var(--green);color:#e8f1e8;padding:25px 18px;overflow:auto}aside a{color:#d1e4d8;text-decoration:none;display:block;font-size:13px;padding:6px 0;border-bottom:1px solid #35574d}aside strong{display:block;letter-spacing:2px;font-size:13px}aside p{font-size:13px;color:#b9cfc3}main{margin-left:280px;padding:44px 50px;max-width:1500px;background:var(--paper);min-height:100vh}h1{font-size:38px;line-height:1.15;max-width:900px;color:var(--green)}h2{font-size:26px;line-height:1.3;border-top:2px solid #cad7ca;padding-top:30px;margin-top:58px;color:var(--green)}p{max-width:100ch}a{color:#176759}code{font:13px/1.5 Consolas,monospace;background:#e9eee7;padding:2px 4px;overflow-wrap:anywhere}pre{background:#132e29;color:#e3f4df;border-radius:10px;padding:20px;overflow:auto}pre code{background:transparent;color:inherit;overflow-wrap:normal}figure{margin:30px 0;overflow:auto}figure svg{width:100%;min-width:700px;height:auto}figcaption{font-size:13px;color:#5e6c62}table{border-collapse:collapse;width:100%;font-size:14px;margin:20px 0}td,th{text-align:left;vertical-align:top;border:1px solid #d7dfd4;padding:10px 12px}th{background:#e5eee4;font-weight:650}tr:nth-child(even){background:#f4f5ef}.table-scroll{overflow:auto}input{width:100%;padding:11px;border:1px solid #a6b9ac;border-radius:6px;font:inherit}button{border:0;padding:10px 15px;background:#dcebdc;color:#173b35;border-radius:6px;cursor:pointer;font:inherit;margin:5px 5px 5px 0}.toolbar{position:sticky;top:0;background:#fcfbf7ed;padding:8px 0;z-index:2;display:flex;align-items:center;gap:8px}.toolbar input{max-width:500px}.dependency{border:1px solid #d1ddcf;border-radius:8px;margin:9px 0;padding:12px 16px}.dependency summary{cursor:pointer;font-weight:650}.dependency small{color:#56695c}.dependency ul{font-size:12px;max-height:200px;overflow:auto}.hidden{display:none}.tag{font:12px system-ui;background:#e8eee4;padding:2px 6px;border-radius:3px}li{margin-bottom:10px}#result-count{font-size:14px}@media(max-width:1000px){aside{position:static;width:auto;max-height:260px}main{margin:0;padding:25px}h1{font-size:31px}}@media print{aside,.toolbar,#dependency-search,#dependency-results,#result-count{display:none!important}main{margin:0;padding:0;max-width:none}.hidden{display:block!important}body{font-size:10pt;background:white}h2{break-after:avoid;margin-top:25px}figure{break-inside:avoid}figure svg{min-width:0}table{font-size:8pt}pre{white-space:pre-wrap}a{color:inherit}details{display:none}}
</style></head><body><aside><strong>IP MESSENGER</strong><p>Architecture & implementation study<br>22 September 2026</p><nav aria-label="Contents">${toc.map(([id,title])=>`<a href="#${id}">${esc(title)}</a>`).join('')}<a href="#dependency-explorer">Dependency explorer</a><a href="ARCHITECTURE-STUDY.md">Editable Markdown</a></nav></aside><main><div class="toolbar"><input id="section-search" aria-label="Filter study sections" type="search" placeholder="Filter study sections…"><button id="clear-search">Show all</button><button id="print">Print / save PDF</button></div>${html}${appendix}</main><script id="dependency-data" type="application/json">${JSON.stringify(dataset).replaceAll('<','\\u003c')}</script><script>
const data=JSON.parse(document.getElementById('dependency-data').textContent);
const escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const search=document.getElementById('dependency-search');
function renderDeps(){const q=search.value.trim().toLowerCase();const matches=data.filter(d=>JSON.stringify(d).toLowerCase().includes(q));document.getElementById('result-count').textContent=matches.length+' matching entries; showing '+Math.min(matches.length,100)+'. Narrow the search or use the CSV for all rows.';document.getElementById('dependency-results').innerHTML=matches.slice(0,100).map(d=>'<details class="dependency"><summary>'+escapeHtml(d.name)+' <span class="tag">'+escapeHtml(d.version)+'</span></summary><p>'+escapeHtml(d.description||'No description in available installed metadata.')+'</p><small>'+escapeHtml(d.location)+'<br>Installed: '+d.installed+' · Development-only lock flag: '+d.developmentOnly+' · Optional: '+d.optional+' · License metadata: '+escapeHtml(d.license||'not available')+'</small><p>Requested by:</p><ul>'+d.requestedBy.map(p=>'<li>'+escapeHtml(p)+'</li>').join('')+'</ul></details>').join('');}
search.addEventListener('input',renderDeps);renderDeps();
const sectionSearch=document.getElementById('section-search');function filterSections(){const q=sectionSearch.value.toLowerCase();document.querySelectorAll('.study-section').forEach(s=>s.classList.toggle('hidden',!!q&&!s.textContent.toLowerCase().includes(q)));}sectionSearch.addEventListener('input',filterSections);document.getElementById('clear-search').onclick=()=>{sectionSearch.value='';filterSections();};document.getElementById('print').onclick=()=>{sectionSearch.value='';filterSections();window.print();};document.querySelectorAll('nav a[href^="#"]').forEach(a=>a.addEventListener('click',()=>{sectionSearch.value='';filterSections();}));
</script></body></html>`;
fs.writeFileSync(path.join(dir,'index.html'),content);
console.log(JSON.stringify({diagrams:fs.readdirSync(diagrams).length,sections:toc.length,words:markdown.split(/\s+/).length,htmlBytes:Buffer.byteLength(content)}));
