function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export class EmailView {
  static render(title: string, body: string, action: string, url: string) {
    const safeUrl = escapeHtml(url)
    return `<!doctype html>
  <html lang="pt"><body style="margin:0;background:#f6f4fb;font-family:Arial,sans-serif;color:#17131f">
    <div style="max-width:520px;margin:0 auto;padding:44px 20px">
      <div style="background:#fff;border:1px solid #e8e3ef;border-radius:20px;padding:36px">
        <p style="font-size:22px;font-weight:700;margin:0 0 26px">Fontes</p>
        <h1 style="font-size:25px;line-height:1.25;margin:0 0 14px">${escapeHtml(title)}</h1>
        <p style="font-size:16px;line-height:1.55;color:#585061;margin:0 0 28px">${escapeHtml(body)}</p>
        <a href="${safeUrl}" style="display:inline-block;background:#17131f;color:#fff;text-decoration:none;border-radius:10px;padding:13px 20px;font-weight:600">${escapeHtml(action)}</a>
        <p style="font-size:12px;line-height:1.5;color:#82798c;margin:28px 0 0">Se não foste tu, podes ignorar este email.</p>
      </div>
    </div>
  </body></html>`
  }
}
