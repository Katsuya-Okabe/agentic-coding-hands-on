// 軽量な Markdown レンダラー（見出し、リスト、引用、コード、太字、斜体、リンク、チェックボックス）
(function () {
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function render(src) {
    const lines = src.replace(/\r/g, "").split("\n");
    const out = [];
    let list = null;
    let inCode = false;
    let code = [];

    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };

    for (const line of lines) {
      if (line.startsWith("```")) {
        if (inCode) {
          out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
          code = [];
        } else {
          closeList();
        }
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        code.push(line);
        continue;
      }

      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      } else if ((m = line.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)$/i))) {
        if (list !== "ul") { closeList(); out.push('<ul class="tasks">'); list = "ul"; }
        out.push(`<li><input type="checkbox" disabled ${m[1].trim() ? "checked" : ""}> ${inline(m[2])}</li>`);
      } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        closeList();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if (/^---+$/.test(line.trim())) {
        closeList();
        out.push("<hr>");
      } else if (line.trim() === "") {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (inCode) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    closeList();
    return out.join("\n");
  }

  window.Markdown = { render, escapeHtml, inline };
})();
