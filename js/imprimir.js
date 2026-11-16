// Gera relatórios em PDF prontos para imprimir (jsPDF + AutoTable, carregados sob demanda).
// Expõe window.Impressao = { gerarPDF(relatorio) -> Promise<Blob> }.
//
// relatorio = {
//   titulo: 'Extrato', subtitulo: ['linha 1', 'linha 2'],
//   secoes: [
//     { titulo: 'Resumo', pares: [['Total pago', 'R$ 1,00'], ...] },
//     { titulo: 'Movimentações', tabela: { cab: ['Data', ...], linhas: [[...]], direita: [4], larguras: {1: 60} } }
//   ]
// }
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = [
    [() => window.jspdf && window.jspdf.jsPDF, CDN + 'jspdf@2.5.1/dist/jspdf.umd.min.js'],
    [() => window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable, CDN + 'jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js']
  ];
  let carregando = null;

  function script(src) {
    return new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => falha(new Error('Não consegui baixar o gerador de PDF. Verifique a internet e tente de novo.'));
      document.head.appendChild(s);
    });
  }
  function carregar() {
    if (!carregando) {
      carregando = (async () => { for (const [pronto, src] of LIBS) if (!pronto()) await script(src); })()
        .catch(e => { carregando = null; throw e; });
    }
    return carregando;
  }

  // As fontes padrão do PDF cobrem português (acentos, ç), mas não alguns símbolos
  function limpar(t) {
    return String(t ?? '')
      .replace(/[−–—]/g, '-').replace(/[•·]/g, '-').replace(/…/g, '...')
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ | /g, ' ')
      .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');
  }

  async function gerarPDF(rel) {
    await carregar();
    const { jsPDF } = window.jspdf;
    const temTabelaLarga = rel.secoes.some(s => s.tabela && s.tabela.cab.length > 5);
    const doc = new jsPDF({ orientation: temTabelaLarga ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const L = doc.internal.pageSize.getWidth(), A = doc.internal.pageSize.getHeight(), M = 12;
    const azul = [47, 91, 234], cinza = [107, 114, 128], texto = [29, 33, 41];

    // Cabeçalho
    let y = M + 4;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...texto);
    doc.text(limpar(rel.titulo), M, y);
    y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...cinza);
    const gerado = 'Gerado em ' + new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    for (const s of [...(rel.subtitulo || []), gerado]) {
      const ls = doc.splitTextToSize(limpar(s), L - 2 * M);
      doc.text(ls, M, y); y += ls.length * 4.6;
    }
    doc.setDrawColor(...azul); doc.setLineWidth(0.6); doc.line(M, y, L - M, y);
    y += 6;

    const novaPaginaSePreciso = h => { if (y + h > A - M - 6) { doc.addPage(); y = M + 4; } };

    for (const sec of rel.secoes) {
      if (sec.pares && !sec.pares.length) continue;
      novaPaginaSePreciso(18);
      if (sec.titulo) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...texto);
        doc.text(limpar(sec.titulo), M, y); y += 2;
      }
      if (sec.pares) {
        doc.autoTable({
          startY: y + 1, margin: { left: M, right: M },
          body: sec.pares.map(([k, v]) => [limpar(k), limpar(v)]),
          theme: 'plain', styles: { fontSize: 10, cellPadding: 1.4, textColor: texto },
          columnStyles: { 0: { textColor: cinza, cellWidth: 70 }, 1: { fontStyle: 'bold' } },
          tableWidth: Math.min(150, L - 2 * M)
        });
        y = doc.lastAutoTable.finalY + 7;
      } else if (sec.tabela) {
        const t = sec.tabela;
        const colStyles = {};
        (t.direita || []).forEach(i => { colStyles[i] = Object.assign(colStyles[i] || {}, { halign: 'right' }); });
        Object.entries(t.larguras || {}).forEach(([i, w]) => { colStyles[i] = Object.assign(colStyles[i] || {}, { cellWidth: w }); });
        doc.autoTable({
          startY: y + 1, margin: { left: M, right: M, bottom: M + 6 },
          head: [t.cab.map(limpar)],
          body: t.linhas.map(l => l.map(limpar)),
          foot: t.rodape ? [t.rodape.map(limpar)] : undefined,
          showFoot: 'lastPage',
          theme: 'striped',
          styles: { fontSize: 8.5, cellPadding: 1.6, textColor: texto, overflow: 'linebreak' },
          headStyles: { fillColor: azul, textColor: 255, fontStyle: 'bold' },
          footStyles: { fillColor: [235, 238, 245], textColor: texto, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [246, 247, 249] },
          columnStyles: colStyles,
          didParseCell: d => {
            if (d.section !== 'body' && (t.direita || []).includes(d.column.index)) d.cell.styles.halign = 'right';
            // valores negativos em laranja, positivos em verde (colunas de valor)
            if (d.section === 'body' && (t.direita || []).includes(d.column.index) && t.colorir !== false) {
              const v = String(d.cell.raw);
              if (/^-/.test(v)) d.cell.styles.textColor = [194, 65, 12];
            }
          }
        });
        y = doc.lastAutoTable.finalY + 7;
      }
    }

    // Rodapé com número da página
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...cinza);
      doc.text(limpar(rel.titulo), M, A - 6);
      doc.text(`Página ${i} de ${n}`, L - M, A - 6, { align: 'right' });
    }
    doc.autoPrint(); // ao abrir o PDF, o leitor já oferece imprimir
    return doc.output('blob');
  }

  window.Impressao = { gerarPDF };
})();
