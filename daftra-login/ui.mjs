// Pages served to Safari on the iPhone. The login page has no script at all; the remote-browser page has ONE inline script (CSP nonce).
const esc = (v) => String(v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

const BASE_CSS = `*{box-sizing:border-box}body{margin:0;padding:14px;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#0f1115;color:#eef0f3}
main{max-width:520px;margin:auto}h1{font-size:19px;margin:6px 0 10px}p,li{color:#b8bdc6}
input,button{font:inherit;padding:12px;margin:5px 0;width:100%;border-radius:10px;border:1px solid #3a3f4b;background:#181b22;color:#eef0f3}
button{background:#2f6bff;border:0;color:#fff;font-weight:600}button.ghost{background:#2a2f3a}button.danger{background:#b42318}
.bad{background:#7a1d14;padding:10px;border-radius:10px}.card{background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:12px;margin:10px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#0b0d11;border:1px solid #2a2f3a;border-radius:10px;padding:10px;font-size:13px}`;

export function startPage({ tenantHost, message } = {}) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>BASHT — Daftra login</title><style>${BASE_CSS}</style></head><body><main>
<h1>تسجيل الدخول إلى دفترة / Daftra sign-in</h1>
<p>متصفح مؤقت ومعزول. تدخل بريدك ورمز OTP بنفسك داخل الصفحة التالية؛ لا يمر شيء منهما بباشت أو بالمحادثة. المستأجر: <b dir="ltr">${esc(tenantHost)}</b></p>
${message ? `<div class="bad">${esc(message)}</div>` : ''}
<form method="post" action="/start" autocomplete="off"><label>رمز الوصول / Access code
<input type="password" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
<button type="submit">بدء / Start</button></form></main></body></html>`;
}

export function appPage({ nonce, csrf, tenantHost, maxMinutes }) {
  const script = `(() => {
  const $ = (id) => document.getElementById(id);
  const csrf = document.body.dataset.csrf;
  const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf': csrf }, body: JSON.stringify(body) })
    .then((r) => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false }));
  const img = $('screen'); const status = $('status');
  const es = new EventSource('/events');
  es.addEventListener('frame', (e) => { img.src = 'data:image/jpeg;base64,' + e.data; });
  es.addEventListener('status', (e) => { try { status.textContent = JSON.parse(e.data).text || ''; } catch (_) {} });
  es.addEventListener('closed', () => { es.close(); status.textContent = 'انتهت الجلسة / Session ended'; document.body.classList.add('ended'); });
  img.addEventListener('click', (ev) => { const r = img.getBoundingClientRect(); post('/input', { type: 'tap', fx: (ev.clientX - r.left) / r.width, fy: (ev.clientY - r.top) / r.height }); });
  $('hide').addEventListener('change', (e) => { $('txt').type = e.target.checked ? 'password' : 'text'; });
  $('send').addEventListener('submit', (e) => { e.preventDefault(); const v = $('txt').value; if (!v) return; $('txt').value = ''; post('/input', { type: 'text', text: v }); });
  document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => post('/input', { type: 'key', key: b.dataset.key })));
  document.querySelectorAll('[data-scroll]').forEach((b) => b.addEventListener('click', () => post('/input', { type: 'scroll', dir: b.dataset.scroll })));
  $('proof').addEventListener('submit', async (e) => {
    e.preventDefault(); const id = $('inv').value.trim(); if (!/^[1-9][0-9]{0,14}$/.test(id)) { $('out').textContent = 'رقم فاتورة غير صالح'; return; }
    $('out').textContent = '… جارٍ الاختبار / testing …';
    const r = await post('/proof', { invoice_id: id }); $('out').textContent = JSON.stringify(r, null, 2);
  });
  $('finish').addEventListener('click', async () => { await post('/finish', {}); es.close(); status.textContent = 'تم الإنهاء وحذف المتصفح / Finished, browser deleted'; document.body.classList.add('ended'); });
})();`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>BASHT — Daftra login</title>
<style>${BASE_CSS}#screen{width:100%;height:auto;border-radius:12px;border:1px solid #2a2f3a;background:#000;touch-action:manipulation;-webkit-user-select:none;user-select:none}
.row{display:flex;gap:6px}.row button{flex:1}.ended #screen,.ended form,.ended .row{opacity:.35;pointer-events:none}#status{font-size:13px;color:#8d93a0;min-height:20px}</style></head>
<body data-csrf="${esc(csrf)}"><main>
<h1>دفترة — <span dir="ltr">${esc(tenantHost)}</span></h1>
<div id="status">…</div>
<img id="screen" alt="remote browser" width="430" height="900">
<div class="row"><button class="ghost" data-scroll="up">↑</button><button class="ghost" data-scroll="down">↓</button><button class="ghost" data-key="Tab">Tab</button><button class="ghost" data-key="Backspace">⌫</button><button class="ghost" data-key="Enter">Enter</button></div>
<form id="send" autocomplete="off"><input id="txt" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="اضغط حقل الصورة ثم اكتب هنا (بريد / OTP) — tap a field, then type here">
<label><input id="hide" type="checkbox" style="width:auto"> إخفاء ما أكتب / hide what I type</label><button type="submit">إرسال إلى الحقل / Send to field</button></form>
<div class="card"><b>بعد تسجيل الدخول — اختبار PDF الرسمي</b>
<form id="proof"><input id="inv" inputmode="numeric" pattern="[0-9]*" maxlength="15" placeholder="رقم الفاتورة / invoice id (مثال 97900)" autocomplete="off"><button type="submit">اختبر تنزيل PDF</button></form>
<pre id="out">—</pre><p>النتيجة بيانات وصفية فقط (حالة HTTP، النوع، الحجم، هل هو PDF). لا يُعرض أو يُحفظ أي ملف.</p></div>
<button id="finish" class="danger" type="button">إنهاء وحذف المتصفح / Finish &amp; delete browser</button>
<p>تنتهي الجلسة تلقائيًا بعد ${esc(maxMinutes)} دقيقة كحد أقصى.</p></main>
<script nonce="${esc(nonce)}">${script}</script></body></html>`;
}
