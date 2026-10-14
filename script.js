const DB_KEY="ga_management_v1";
const emptyDB={inventory:[],transactions:[],assets:[],vehicles:[],facilities:[],requests:[],accommodation:[],canteen:[],vendors:[],activity:[]};
let db=loadDB(),formType="",editId=null;

function loadDB(){
  try{
    const saved=localStorage.getItem(DB_KEY);
    return saved?{...structuredClone(emptyDB),...JSON.parse(saved)}:structuredClone(emptyDB);
  }catch(error){return structuredClone(emptyDB)}
}
function saveDB(){
  localStorage.setItem(DB_KEY,JSON.stringify(db));
  renderAll();
}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function esc(value){
  return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function today(){return new Date().toISOString().slice(0,10)}
function formatDate(value){
  if(!value)return"-";
  const d=new Date(value+"T00:00:00");
  return isNaN(d)?esc(value):d.toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric"});
}
function rupiah(value){return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(value)||0)}
function notify(message){
  const el=document.getElementById("toast");
  el.textContent=message;el.classList.add("show");
  clearTimeout(notify.timer);notify.timer=setTimeout(()=>el.classList.remove("show"),2800);
}
function logActivity(message){
  db.activity.unshift({id:uid(),message,date:new Date().toLocaleString("id-ID")});
  db.activity=db.activity.slice(0,30);
}

function showPage(name, button) {
    if (
    name === "users" &&
    document.body.dataset.userRole !== "main_admin"
  ) {
    return;
  }
  const page = document.getElementById("page-" + name);
  if (!page) return;

  document.querySelectorAll(".page").forEach(function (el) {
    el.classList.remove("active");
  });
  page.classList.add("active");

  document.querySelectorAll(".nav-link").forEach(function (el) {
    el.classList.remove("active");
  });

  if (button) {
    button.classList.add("active");
  }

  const breadcrumb = document.getElementById("pageBreadcrumb");
  const label = button
    ? button.textContent.trim()
    : (page.querySelector("h1")?.textContent || name);

  if (breadcrumb) {
    breadcrumb.textContent = label;
  }

  renderAll();
}
const fields={
  inventory:[
    ["code","Kode Barang","text","Contoh: ATK-001",true],
    ["name","Nama Barang","text","Nama barang",true],
    ["category","Kategori","select",["ATK","Kebersihan","Elektronik","Perlengkapan Kantor","Sparepart","Lainnya"],true],
    ["stock","Stok Awal","number","0",true],
    ["minimum","Stok Minimum","number","0",true],
    ["unit","Satuan","select",["pcs","unit","box","rim","pack","liter","kg","set","roll","buah","karton"],true],
    ["location","Lokasi Penyimpanan","text","Gudang / lemari",false]
  ],
  transaction:[
    ["itemId","Pilih Barang","selectItems",[],true],
    ["type","Jenis Transaksi","select",["Masuk","Keluar"],true],
    ["quantity","Jumlah","number","1",true],
    ["date","Tanggal","date",today(),true],
    ["note","Catatan","text","Nomor dokumen / tujuan",false]
  ],
  assets:[
    ["code","Kode Aset","text","Contoh: AST-001",true],
    ["name","Nama Aset","text","Nama aset",true],
    ["category","Kategori","select",["Laptop","Komputer","AC","Meja & Kursi","Printer","Kendaraan","Peralatan","Lainnya"],true],
    ["location","Lokasi","text","Lokasi aset",true],
    ["owner","Penanggung Jawab","text","Nama karyawan",false],
    ["condition","Kondisi","select",["Baik","Perlu Perbaikan","Rusak"],true],
    ["status","Status","select",["Aktif","Dipinjam","Dalam Perbaikan","Tidak Aktif"],true],
    ["date","Tanggal Perolehan","date",today(),false],
    ["value","Nilai Perolehan (Rp)","number","0",false]
  ],
  vehicles:[
    ["plate","Nomor Polisi","text","Contoh: B 1234 ABC",true],
    ["type","Jenis Kendaraan","select",["Mobil","Motor","Pickup","Bus","Truk","Lainnya"],true],
    ["model","Merek / Model","text","Merek kendaraan",true],
    ["location","Lokasi","text","Lokasi kendaraan",false],
    ["user","Pengguna","text","Nama pengguna",false],
    ["status","Status","select",["Tersedia","Digunakan","Servis","Tidak Aktif"],true]
  ],
  facilities:[
    ["date","Tanggal Laporan","date",today(),true],
    ["name","Fasilitas","text","Nama fasilitas",true],
    ["location","Lokasi","text","Lokasi kerusakan",true],
    ["detail","Detail Kerusakan","textarea","Jelaskan kerusakan",true],
    ["priority","Prioritas","select",["Rendah","Sedang","Tinggi","Darurat"],true],
    ["status","Status","select",["Baru","Diproses","Menunggu Vendor","Selesai"],true],
    ["vendor","Vendor","text","Nama vendor jika ada",false]
  ],
  requests:[
    ["date","Tanggal","date",today(),true],
    ["employee","Nama Karyawan","text","Nama karyawan",true],
    ["department","Departemen","text","Departemen",false],
    ["type","Jenis Permintaan","select",["Barang","Kendaraan","Perbaikan","Akomodasi","Kantin","Lainnya"],true],
    ["detail","Detail Permintaan","textarea","Jelaskan kebutuhan",true],
    ["status","Status","select",["Pending","Disetujui","Ditolak","Diproses","Selesai"],true]
  ],
  accommodation:[
    ["location","Lokasi Mess","text","Nama lokasi",true],
    ["room","Nomor Kamar","text","Nomor kamar",true],
    ["capacity","Kapasitas","number","1",true],
    ["occupied","Terisi","number","0",true],
    ["owner","Penanggung Jawab","text","Nama penanggung jawab",false],
    ["status","Status","select",["Tersedia","Penuh","Perbaikan","Tidak Aktif"],true]
  ],
  canteen:[
    ["date","Tanggal","date",today(),true],
    ["type","Jenis Catatan","select",["Operasional","Kebersihan","Keluhan","Stok","Evaluasi","Lainnya"],true],
    ["detail","Detail","textarea","Catatan operasional",true],
    ["vendor","Vendor Kantin","text","Nama vendor",false],
    ["status","Status","select",["Baru","Diproses","Selesai"],true]
  ],
  vendors:[
    ["name","Nama Vendor","text","Nama perusahaan/vendor",true],
    ["category","Kategori","select",["ATK","Kebersihan","Perbaikan","Transportasi","Katering","Akomodasi","Lainnya"],true],
    ["contact","Nama Kontak","text","Nama PIC",false],
    ["phone","Telepon / Email","text","Kontak vendor",false],
    ["status","Status","select",["Aktif","Nonaktif","Evaluasi"],true],
    ["note","Catatan","textarea","Informasi tambahan",false]
  ]
};
const config={
  inventory:{title:"Barang",collection:"inventory",label:"barang",columns:["code","name","category","stock","minimum","unit","status"]},
  assets:{title:"Aset",collection:"assets",label:"aset",columns:["code","name","category","location","owner","condition","status"]},
  vehicles:{title:"Kendaraan",collection:"vehicles",label:"kendaraan",columns:["plate","type","model","location","user","status"]},
  facilities:{title:"Laporan Fasilitas",collection:"facilities",label:"laporan fasilitas",columns:["date","name","location","detail","priority","status"]},
  requests:{title:"Permintaan",collection:"requests",label:"permintaan",columns:["date","employee","type","detail","status"]},
  accommodation:{title:"Data Mess",collection:"accommodation",label:"data mess",columns:["location","room","capacity","occupied","owner","status"]},
  canteen:{title:"Catatan Kantin",collection:"canteen",label:"catatan kantin",columns:["date","type","detail","vendor","status"]},
  vendors:{title:"Vendor",collection:"vendors",label:"vendor",columns:["name","category","contact","phone","status"]}
};
function fieldHTML(field,record={}){
  const [key,label,type,options,required]=field;
  const value=record[key]??(type==="date"?today():"");
  let control="";
  if(type==="selectItems"){
    const choices=db.inventory.map(item=>`<option value="${esc(item.id)}" ${value===item.id?"selected":""}>${esc(item.code)} — ${esc(item.name)} (stok: ${item.stock} ${esc(item.unit)})</option>`).join("");
    control=`<select name="${key}" required><option value="">Pilih barang</option>${choices}</select>`;
  }else if(type==="select"){
    control=`<select name="${key}" ${required?"required":""}><option value="">Pilih ${esc(label.toLowerCase())}</option>${options.map(option=>`<option value="${esc(option)}" ${String(value)===option?"selected":""}>${esc(option)}</option>`).join("")}</select>`;
  }else if(type==="textarea"){
    control=`<textarea name="${key}" placeholder="${esc(options)}" ${required?"required":""}>${esc(value)}</textarea>`;
  }else{
    control=`<input type="${type}" name="${key}" value="${esc(value)}" ${type==="number"?'min="0" step="any"':""} placeholder="${esc(options)}" ${required?"required":""}>`;
  }
  return `<div class="field ${type==="textarea"?"full":""}"><label>${esc(label)}${required?' <span style="color:#C45E55">*</span>':""}</label>${control}</div>`;
}
function openForm(type,id=null){
  if(type==="transaction"){
    notify("Transaksi stok Firebase belum diaktifkan. Sistem penyimpanan aman sedang disiapkan.");
    return;
  }

  formType=type;
  editId=id;

  const form=document.getElementById("dataForm");
  form.reset();

  const record=id
    ? db[config[type]?.collection||type]?.find(x=>x.id===id)
    : null;

  document.getElementById("modalTitle").textContent=
    (id?"Edit ":"Tambah ")+(config[type]?.title||"Transaksi Stok");

  const definitions=fields[type];

  if(!definitions){
    notify("Form tidak ditemukan.");
    return;
  }

  document.getElementById("formFields").innerHTML=
    definitions.map(field=>fieldHTML(field,record||{})).join("");

  if(type==="inventory" && id){
    const stockInput=form.elements.namedItem("stock");

    if(stockInput){
      stockInput.readOnly=true;
      stockInput.title="Stok hanya dapat diubah melalui Transaksi Stok";
    }
  }

  document.getElementById("dataModal").classList.add("open");
}

function closeForm() {
  const modal = document.getElementById("dataModal");

  if (modal) {
    modal.classList.remove("open");
    delete modal.dataset.mode;
  }

  editId = null;
  formType = "";
}

document.getElementById("dataModal").addEventListener("click",event=>{
  if(event.target.id==="dataModal")closeForm();
});
document.addEventListener("keydown",event=>{
  if(event.key==="Escape")closeForm();
});
document.getElementById("dataForm").addEventListener("submit",event=>{
  event.preventDefault();
  const form=new FormData(event.currentTarget);
  const data=Object.fromEntries(form.entries());
  if(formType==="transaction"){saveTransaction(data);return}
  const collection=config[formType]?.collection;
  if(!collection)return;
  const list=db[collection];
  if(["code","plate"].some(key=>data[key]&&list.some(item=>item[key]?.toLowerCase()===data[key].trim().toLowerCase()&&item.id!==editId))){
    notify("Kode atau nomor tersebut sudah digunakan.");return;
  }
 if(formType==="inventory"){
  data.stock=Number(data.stock)||0;
  data.minimum=Number(data.minimum)||0;

  if(editId){
    const existingItem=list.find(item=>item.id===editId);
    if(!existingItem){
      notify("Barang tidak ditemukan.");
      return;
    }
    data.stock=existingItem.stock;
  }
}
  if(formType==="assets")data.value=Number(data.value)||0;
  if(formType==="accommodation"){
    data.capacity=Number(data.capacity)||0;
    data.occupied=Number(data.occupied)||0;
    if(data.occupied>data.capacity){notify("Jumlah terisi tidak boleh melebihi kapasitas.");return}
  }
  data.id=editId||uid();
  if(editId){
    const index=list.findIndex(item=>item.id===editId);
    if(index<0)return;
    list[index]={...list[index],...data};
    logActivity("Memperbarui "+config[formType].label+": "+(data.name||data.code||data.plate||data.room||"data"));
  }else{
    list.unshift(data);
    logActivity("Menambahkan "+config[formType].label+": "+(data.name||data.code||data.plate||data.room||"data"));
  }
  saveDB();closeForm();notify("Data berhasil disimpan.");
});
function saveTransaction(data){
  const item=db.inventory.find(x=>x.id===data.itemId);
  const quantity=Number(data.quantity);
  if(!item){notify("Pilih barang yang valid.");return}
  if(!Number.isFinite(quantity)||quantity<=0){notify("Jumlah harus lebih dari nol.");return}
  if(data.type==="Keluar"&&quantity>Number(item.stock)){notify("Stok tidak mencukupi. Stok tersedia: "+item.stock+" "+item.unit);return}
  item.stock=Number(item.stock)+(data.type==="Masuk"?quantity:-quantity);
  const transaction={id:uid(),itemId:item.id,code:item.code,name:item.name,type:data.type,quantity,date:data.date||today(),note:data.note||""};
  db.transactions.unshift(transaction);
  logActivity("Barang "+data.type.toLowerCase()+": "+item.name+" ("+quantity+" "+item.unit+")");
  saveDB();closeForm();notify("Transaksi tersimpan. Stok terbaru: "+item.stock+" "+item.unit);
}
function deleteRecord(type,id){
  const collection=config[type]?.collection;
  if(!collection)return;
  const item=db[collection].find(x=>x.id===id);
  if(!item)return;
  if(type==="inventory"&&db.transactions.some(t=>t.itemId===id)){
    notify("Barang memiliki riwayat transaksi dan tidak dapat dihapus.");return;
  }
  if(!confirm("Hapus data "+(item.name||item.code||item.plate||"ini")+"?"))return;
  db[collection]=db[collection].filter(x=>x.id!==id);
  logActivity("Menghapus "+config[type].label+": "+(item.name||item.code||item.plate||"data"));
  saveDB();notify("Data dihapus.");
}
function deleteTransaction(id) {
  notify(
    "Penghapusan transaksi sementara dinonaktifkan. " +
    "Fitur arsip dan penyesuaian stok khusus Main Admin sedang disiapkan."
  );
}
function statusHTML(value,stock=null,minimum=null){
  let cls="neutral",text=value||"-";
  if(stock!==null){
    if(Number(stock)<=Number(minimum)) {cls=Number(stock)===0?"danger":"warning";text=Number(stock)===0?"Habis":"Stok Menipis"}
    else{text="Tersedia";cls=""}
  }else if(["Baik","Aktif","Tersedia","Selesai","Disetujui"].includes(value))cls="";
  else if(["Rusak","Darurat","Ditolak","Tidak Aktif"].includes(value))cls="danger";
  else if(["Perlu Perbaikan","Tinggi","Pending","Diproses","Menunggu Vendor","Servis","Penuh"].includes(value))cls="warning";
  return `<span class="status-badge ${cls}">${esc(text)}</span>`;
}
function actions(type,id){
  return `<div class="row-actions"><button class="small-action" onclick="openForm('${type}','${id}')"><i class="fa-solid fa-pen"></i></button><button class="small-action delete" onclick="deleteRecord('${type}','${id}')"><i class="fa-solid fa-trash"></i></button></div>`;
}
function renderTable(id,rows,columns){
  const body=document.getElementById(id);
  if(!body)return;
  body.innerHTML=rows.length?rows.map(item=>`<tr>${columns.map(column=>`<td>${column.render?column.render(item):esc(item[column.key]||"-")}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${columns.length}" class="empty-cell">Belum ada data.</td></tr>`;
}
function col(key,label,render=null){return {key,label,render}}
function actionCol(type){return col("id","Aksi",item=>actions(type,item.id))}
function commonColumns(type){
  return config[type].columns.map(key=>{
    let label=key;
    const labels={code:"Kode",name:"Nama",category:"Kategori",stock:"Stok",minimum:"Minimum",unit:"Satuan",location:"Lokasi",owner:"Penanggung Jawab",condition:"Kondisi",status:"Status",date:"Tanggal",detail:"Detail",priority:"Prioritas",employee:"Karyawan",type:"Jenis",plate:"Nomor Polisi",model:"Merek/Model",user:"Pengguna",room:"Kamar",capacity:"Kapasitas",occupied:"Terisi",vendor:"Vendor",contact:"Kontak",phone:"Telepon / Email",value:"Nilai"};
    label=labels[key]||key;
    let render=null;
    if(key==="status"||key==="condition"||key==="priority")render=item=>statusHTML(item[key]);
    if(key==="stock")render=item=>`<strong>${Number(item.stock)||0}</strong>`;
    if(key==="date")render=item=>formatDate(item.date);
    if(key==="detail")render=item=>`<span title="${esc(item.detail)}">${esc(item.detail?.length>45?item.detail.slice(0,45)+"…":item.detail||"-")}</span>`;
    if(key==="value")render=item=>rupiah(item.value);
    return col(key,label,render);
  }).concat(actionCol(type));
}
let firestoreInventoryPreview = [];

window.receiveFirestoreInventory = function(items) {
  firestoreInventoryPreview = items;
  console.log("Preview Inventory Firebase diterima:", items.length, "barang");
  const table = document.getElementById("firestoreInventoryTable");
  if (!table) return;

  table.replaceChildren();

  items.forEach((item) => {
    const row = document.createElement("tr");

    ["code", "name", "category", "stock", "minimum", "unit", "location"].forEach((field) => {
      const cell = document.createElement("td");
      cell.textContent = item[field] ?? "-";
      row.appendChild(cell);
    });

    table.appendChild(row);
  });
};

window.receiveFirestoreTransactions = function(transactions) {
  const realTransactions = transactions.filter(
    (transaction) => transaction.testOnly !== true
  );

  console.log(
    "Transaksi operasional Firebase diterima:",
    realTransactions.length
  );

  const table = document.getElementById("firestoreTransactionTable");
  if (!table) return;

  table.replaceChildren();

  realTransactions.forEach((transaction) => {
    const row = document.createElement("tr");

    ["date", "itemId", "type", "quantity", "note"].forEach((field) => {
      const cell = document.createElement("td");
      cell.textContent = transaction[field] ?? "-";
      row.appendChild(cell);
    });

    table.appendChild(row);
  });
};
function renderInventory(){
  const search=(document.getElementById("inventorySearch")?.value||"").toLowerCase();
  const items=db.inventory.filter(item=>(item.name+" "+item.code+" "+item.category).toLowerCase().includes(search));
  renderTable("inventoryTable",items,[
    col("code","Kode"),col("name","Nama"),col("category","Kategori"),
    col("stock","Stok",item=>`<strong>${Number(item.stock)||0}</strong>`),
    col("minimum","Minimum"),col("unit","Satuan"),
    col("status","Status",item=>statusHTML("",item.stock,item.minimum)),
    actionCol("inventory")
  ]);
  const dashboardItems=db.inventory.filter(item=>Number(item.stock)<=Number(item.minimum));
  renderTable("dashboardStock",dashboardItems.slice(0,8),[
    col("name","Nama"),col("category","Kategori"),
    col("stock","Stok",item=>`${item.stock} ${esc(item.unit)}`),
    col("minimum","Minimum"),
    col("status","Status",item=>statusHTML("",item.stock,item.minimum))
  ]);
  renderTable("transactionTable",db.transactions.slice(0,100),[
    col("date","Tanggal",item=>formatDate(item.date)),col("code","Kode"),
    col("name","Nama"),col("type","Jenis",item=>statusHTML(item.type==="Masuk"?"Tersedia":"Pending")),
    col("quantity","Jumlah"),col("note","Catatan"),
    col("id","Aksi",item=>`<button class="small-action delete" onclick="deleteTransaction('${item.id}')"><i class="fa-solid fa-trash"></i></button>`)
  ]);
  setText("inventoryCount",db.inventory.length);
  setText("stockUnits",db.inventory.reduce((sum,item)=>sum+(Number(item.stock)||0),0));
  setText("inventoryLow",dashboardItems.length);
}
function setText(id,value){
  const el=document.getElementById(id);if(el)el.textContent=value;
}
function renderAll(){
  renderInventory();
  renderTable("vehicleTable",db.vehicles,commonColumns("vehicles"));
  renderTable("facilityTable",db.facilities,commonColumns("facilities"));
  renderTable("requestTable",db.requests,commonColumns("requests"));
  renderTable("accommodationTable",db.accommodation,commonColumns("accommodation"));
  renderTable("canteenTable",db.canteen,commonColumns("canteen"));
  renderTable("vendorTable",db.vendors,commonColumns("vendors"));
  setText("totalItems",db.inventory.length);
  setText("lowStock",db.inventory.filter(item=>Number(item.stock)<=Number(item.minimum)).length);
  setText("pendingRequests",db.requests.filter(item=>["Pending","Diproses"].includes(item.status)).length);
  setText("reportItems",db.inventory.length);
  setText("reportStock",db.inventory.reduce((sum,item)=>sum+(Number(item.stock)||0),0));
  setText("reportTransactions",db.transactions.length);
  const activity=document.getElementById("recentActivity");
  if(activity){
    activity.innerHTML=db.activity.length?db.activity.slice(0,8).map(item=>`<div class="activity-row"><span class="activity-dot"></span><div><p>${esc(item.message)}</p><small>${esc(item.date)}</small></div></div>`).join(""):`<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>Belum ada aktivitas.</p><small>Transaksi yang kamu catat akan muncul di sini.</small></div>`;
  }
  
  
function renderAll() {
  renderInventory();

  renderTable("vehicleTable", db.vehicles, commonColumns("vehicles"));
  renderTable("facilityTable", db.facilities, commonColumns("facilities"));
  renderTable("requestTable", db.requests, commonColumns("requests"));
  renderTable("accommodationTable", db.accommodation, commonColumns("accommodation"));
  renderTable("canteenTable", db.canteen, commonColumns("canteen"));
  renderTable("vendorTable", db.vendors, commonColumns("vendors"));

  setText("totalItems", db.inventory.length);
  setText("lowStock", db.inventory.filter(item =>
    Number(item.stock) <= Number(item.minimum)
  ).length);

  setText("pendingRequests", db.requests.filter(item =>
    ["Pending", "Diproses"].includes(item.status)
  ).length);

  setText("reportItems", db.inventory.length);
  setText("reportStock", db.inventory.reduce(
    (sum, item) => sum + (Number(item.stock) || 0), 0
  ));
  setText("reportTransactions", db.transactions.length);

  const activity = document.getElementById("recentActivity");

  if (activity) {
    activity.innerHTML = db.activity.length
      ? db.activity.slice(0, 8).map(item => `
          <div class="activity-row">
            <span class="activity-dot"></span>
            <div>
              <p>${esc(item.message)}</p>
              <small>${esc(item.date)}</small>
            </div>
          </div>
        `).join("")
      : `<div class="empty-state">
          <i class="fa-solid fa-inbox"></i>
          <p>Belum ada aktivitas.</p>
          <small>Transaksi yang kamu catat akan muncul di sini.</small>
        </div>`;
  }

  if (typeof window.renderFirestoreAssets === "function") {
    window.renderFirestoreAssets();
  }
}

const dateEl = document.getElementById("todayDate");

if (dateEl) {
  dateEl.textContent = new Date().toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

renderAll();
