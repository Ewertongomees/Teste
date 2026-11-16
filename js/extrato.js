// Leitura de extratos bancários (OFX e CSV) exportados pelo internet banking.
// Expõe window.Extrato = { ler(arquivo), categorizar(descricao) }.
(function () {
  'use strict';

  // ---------- Leitura do arquivo (UTF-8 ou Windows-1252, comum em bancos BR) ----------
  async function lerTexto(arquivo) {
    const buf = await arquivo.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1252').decode(buf); }
  }

  async function ler(arquivo) {
    if (/\.pdf$/i.test(arquivo.name) || arquivo.type === 'application/pdf') {
      const r = await lerPDF(arquivo);
      r.transacoes = r.transacoes.filter(t => t.data && Number.isFinite(t.valor) && t.valor !== 0);
      if (!r.transacoes.length) throw new Error('Não encontrei movimentações neste PDF. Se puder, exporte o extrato em OFX ou CSV.');
      r.formato = 'PDF';
      return r;
    }
    const texto = await lerTexto(arquivo);
    const ehOFX = /<OFX>/i.test(texto) || /OFXHEADER/i.test(texto) || /\.ofx$/i.test(arquivo.name);
    const r = ehOFX ? lerOFX(texto) : lerCSV(texto);
    r.transacoes = r.transacoes.filter(t => t.data && Number.isFinite(t.valor) && t.valor !== 0);
    if (!r.transacoes.length) throw new Error('Nenhuma movimentação encontrada no arquivo.');
    r.formato = ehOFX ? 'OFX' : 'CSV';
    return r;
  }

  // ---------- OFX ----------
  function tag(bloco, nome) {
    const m = bloco.match(new RegExp('<' + nome + '>([^<\\r\\n]*)', 'i'));
    return m ? m[1].trim() : '';
  }
  function dataOFX(s) {
    const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }
  function numeroOFX(s) {
    s = s.replace(/\s/g, '');
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    return Number(s);
  }
  function lerOFX(texto) {
    const blocos = texto.split(/<STMTTRN>/i).slice(1);
    const transacoes = blocos.map(b => {
      b = b.split(/<\/STMTTRN>/i)[0];
      const memo = tag(b, 'MEMO');
      const nome = tag(b, 'NAME');
      return {
        data: dataOFX(tag(b, 'DTPOSTED')),
        valor: Math.round(numeroOFX(tag(b, 'TRNAMT')) * 100) / 100,
        descricao: (memo && nome && memo !== nome ? `${nome} ${memo}` : memo || nome || 'Movimentação').replace(/\s+/g, ' '),
        fitid: tag(b, 'FITID')
      };
    });
    let saldo = null, dataSaldo = null;
    const ledger = texto.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i);
    if (ledger) {
      const v = numeroOFX(tag(ledger[1], 'BALAMT'));
      if (Number.isFinite(v)) { saldo = Math.round(v * 100) / 100; dataSaldo = dataOFX(tag(ledger[1], 'DTASOF')); }
    }
    return { transacoes, saldo, dataSaldo };
  }

  // ---------- CSV ----------
  function normalizar(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  function separarLinhas(texto, sep) {
    const linhas = [];
    let campo = '', linha = [], aspas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (aspas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') aspas = false;
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === sep) { linha.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && texto[i + 1] === '\n') i++;
        linha.push(campo); campo = '';
        if (linha.some(x => x.trim())) linhas.push(linha);
        linha = [];
      } else campo += c;
    }
    linha.push(campo);
    if (linha.some(x => x.trim())) linhas.push(linha);
    return linhas;
  }

  function dataCSV(s) {
    s = String(s).trim();
    let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) {
      const ano = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }

  function valorCSV(s) {
    s = String(s).trim();
    if (!s) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/\bD$/i.test(s)) { neg = true; s = s.replace(/\s*D$/i, ''); }
    s = s.replace(/\s*C$/i, '').replace(/R\$\s?/i, '').replace(/\s/g, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
    const ultVirg = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
    if (ultVirg > ultPonto) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    const v = Number(s);
    return neg ? -v : v;
  }

  function lerCSV(texto) {
    const primeira = texto.split(/\r?\n/).find(l => l.trim()) || '';
    const sep = [';', '\t', ','].sort((a, b) => primeira.split(b).length - primeira.split(a).length)[0];
    const linhas = separarLinhas(texto.replace(/^﻿/, ''), sep);

    // Procura a linha de cabeçalho (alguns bancos colocam linhas de título antes)
    let iCab = -1, col = {};
    for (let i = 0; i < Math.min(linhas.length, 15); i++) {
      const cab = linhas[i].map(normalizar);
      const achar = re => cab.findIndex(c => re.test(c));
      const c = {
        data: achar(/^data|^dt\b|date/),
        desc: achar(/descri|histor|lancamento|memo|estabelecimento|detalhe|title|titulo/),
        valor: achar(/^valor|quantia|montante|amount|^value/),
        debito: achar(/debito|saida/),
        credito: achar(/credito|entrada/)
      };
      if (c.data >= 0 && (c.valor >= 0 || c.debito >= 0 || c.credito >= 0)) { iCab = i; col = c; break; }
    }

    if (iCab < 0) {
      // Sem cabeçalho: adivinha pelas colunas da primeira linha com data
      const amostra = linhas.find(l => l.some(x => dataCSV(x))) || [];
      col.data = amostra.findIndex(x => dataCSV(x));
      col.valor = amostra.map((x, i) => i).reverse().find(i => i !== col.data && Number.isFinite(valorCSV(amostra[i])));
      col.desc = amostra.map((x, i) => i).filter(i => i !== col.data && i !== col.valor)
        .sort((a, b) => (amostra[b] || '').length - (amostra[a] || '').length)[0];
      col.debito = col.credito = -1;
      if (col.data < 0 || col.valor === undefined) throw new Error('Não reconheci as colunas do CSV. Ele precisa ter data, descrição e valor.');
    }

    const transacoes = [];
    for (const l of linhas.slice(iCab + 1)) {
      const data = dataCSV(l[col.data] || '');
      if (!data) continue;
      let valor;
      if (col.valor >= 0 && Number.isFinite(valorCSV(l[col.valor]))) valor = valorCSV(l[col.valor]);
      else {
        const deb = col.debito >= 0 ? Math.abs(valorCSV(l[col.debito]) || 0) : 0;
        const cred = col.credito >= 0 ? Math.abs(valorCSV(l[col.credito]) || 0) : 0;
        valor = cred - deb;
      }
      const descricao = (col.desc >= 0 ? l[col.desc] : '').trim().replace(/\s+/g, ' ') || 'Movimentação';
      if (/saldo/i.test(normalizar(descricao)) && /^saldo/.test(normalizar(descricao))) continue; // linhas "SALDO DO DIA"
      transacoes.push({ data, valor: Math.round(valor * 100) / 100, descricao, fitid: '' });
    }
    return { transacoes, saldo: null, dataSaldo: null };
  }

  // ---------- PDF (extratos em tabela: Data | Histórico | Docto | Crédito | Débito | Saldo) ----------
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  let pdfjsPromise = null;
  function carregarPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((ok, falha) => {
        const s = document.createElement('script');
        s.src = PDFJS + 'pdf.min.js';
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
          ok(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsPromise = null; falha(new Error('Não consegui carregar o leitor de PDF. Verifique a internet e tente de novo.')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  async function lerPDF(arquivo) {
    const pdfjs = await carregarPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
    const paginas = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pag = await doc.getPage(n);
      const conteudo = await pag.getTextContent();
      paginas.push(conteudo.items
        .filter(i => i.str && i.str.trim())
        .map(i => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width })));
    }
    return interpretarPaginasPDF(paginas);
  }

  const RE_NUM = /^-?\(?(R\$\s?)?-?\d{1,3}(\.\d{3})*,\d{2}\)?\s*[DC-]?$|^-?\d+,\d{2}$/;
  const RE_DATA = /^\d{2}\/\d{2}\/\d{2,4}$/;

  function agruparLinhas(itens) {
    const ordenados = [...itens].sort((a, b) => b.y - a.y || a.x - b.x);
    const linhas = [];
    for (const it of ordenados) {
      const l = linhas.find(l => Math.abs(l.y - it.y) < 2.5);
      if (l) l.itens.push(it); else linhas.push({ y: it.y, itens: [it] });
    }
    linhas.forEach(l => l.itens.sort((a, b) => a.x - b.x));
    return linhas;
  }

  function interpretarPaginasPDF(paginas) {
    const transacoes = [];
    let ultimaData = '';
    const saldosAbs = [];
    let viuCabecalho = false;

    for (const itens of paginas) {
      const linhas = agruparLinhas(itens);
      // Cabeçalho da tabela
      const iCab = linhas.findIndex(l => {
        const t = l.itens.map(i => normalizar(i.str));
        return t.some(s => /^data\b/.test(s)) && t.some(s => /credito|debito|^valor/.test(s));
      });
      if (iCab < 0) continue;
      viuCabecalho = true;
      const cols = linhas[iCab].itens.map(i => {
        const n = normalizar(i.str);
        const nome = /^data/.test(n) ? 'data' : /credito|entrada/.test(n) ? 'credito' : /debito|saida/.test(n) ? 'debito'
          : /^saldo/.test(n) ? 'saldo' : /^valor/.test(n) ? 'valor' : /doc/.test(n) ? 'doc' : 'desc';
        return { nome, x: i.x };
      });
      const colunaDe = it => {
        const ref = RE_NUM.test(it.str) ? it.x + it.w - 1 : it.x; // números são alinhados à direita
        let c = cols[0];
        for (const k of cols) if (k.x - 4 <= ref) c = k; // tolerância: o texto costuma começar um pouco antes do título
        return c.nome;
      };

      // Linhas do corpo (até a linha "Total")
      const corpo = [];
      for (const l of linhas.slice(iCab + 1)) {
        if (/^total\b/i.test(normalizar(l.itens[0].str))) break;
        corpo.push({ y: l.y, itens: l.itens.map(it => ({ ...it, col: colunaDe(it) })) });
      }

      // Âncoras = linhas com valor; demais linhas (descrição em 2 linhas, data) vão para a âncora mais próxima
      const ancoras = corpo.filter(l => l.itens.some(i => ['credito', 'debito', 'valor'].includes(i.col) && RE_NUM.test(i.str)))
        .map(l => ({ ...l, extras: [] }));
      if (!ancoras.length) continue;
      for (const l of corpo) {
        if (ancoras.some(a => a.y === l.y)) continue;
        const a = ancoras.reduce((m, a) => Math.abs(a.y - l.y) < Math.abs(m.y - l.y) ? a : m);
        if (Math.abs(a.y - l.y) < 30) a.extras.push(l);
      }

      for (const a of ancoras) {
        const todas = [a, ...a.extras].sort((p, q) => q.y - p.y);
        const itensTodos = todas.flatMap(l => l.itens);
        const dataTxt = itensTodos.find(i => RE_DATA.test(i.str));
        if (dataTxt) ultimaData = dataCSV(dataTxt.str);
        const desc = todas.map(l => l.itens.filter(i => i.col === 'desc').map(i => i.str).join(' ')).filter(Boolean)
          .join(' - ').replace(/\b(REM|DES):\s*/g, '').replace(/\s+\d{2}\/\d{2}$/, '').replace(/\s+/g, ' ').trim();
        const num = nome => { const i = a.itens.find(i => i.col === nome && RE_NUM.test(i.str)); return i ? valorCSV(i.str) : NaN; };
        let valor;
        if (Number.isFinite(num('valor'))) valor = num('valor');
        else valor = (Math.abs(num('credito')) || 0) - (Math.abs(num('debito')) || 0);
        if (/^saldo/i.test(normalizar(desc))) continue;
        const doc = a.itens.find(i => i.col === 'doc');
        transacoes.push({ data: ultimaData, valor: Math.round(valor * 100) / 100, descricao: desc || 'Movimentação', doc: doc ? doc.str : '' });
        saldosAbs.push(Number.isFinite(num('saldo')) ? num('saldo') : NaN);
      }
    }
    if (!viuCabecalho) throw new Error('Não reconheci o layout deste PDF. Se puder, exporte o extrato em OFX ou CSV.');

    // Identificador estável para não duplicar ao reimportar
    const vistos = {};
    for (const t of transacoes) {
      const base = `${t.data}|${t.doc}|${t.valor}`;
      vistos[base] = (vistos[base] || 0) + 1;
      t.fitid = 'pdf:' + base + '|' + vistos[base];
      delete t.doc;
    }

    // Saldo: o PDF mostra o saldo sem sinal (negativo só pela cor). Descobre o sinal pela soma das movimentações.
    let saldo = null, dataSaldo = null;
    const idx = saldosAbs.map((s, i) => i).filter(i => Number.isFinite(saldosAbs[i]));
    if (idx.length) {
      let acum = 0;
      const cum = transacoes.map(t => (acum = Math.round((acum + t.valor) * 100) / 100));
      const i0 = idx[0];
      const candidatos = [saldosAbs[i0] - cum[i0], -saldosAbs[i0] - cum[i0]];
      const erro = p0 => idx.reduce((e, i) => e + Math.abs(Math.abs(p0 + cum[i]) - saldosAbs[i]), 0);
      const p0 = erro(candidatos[0]) <= erro(candidatos[1]) ? candidatos[0] : candidatos[1];
      const ult = idx[idx.length - 1];
      saldo = Math.round((p0 + cum[ult]) * 100) / 100;
      if (Math.abs(Math.abs(saldo) - saldosAbs[ult]) > 0.01) saldo = saldosAbs[ult]; // não bateu: usa o valor impresso
      dataSaldo = transacoes[ult].data;
    }
    return { transacoes, saldo, dataSaldo };
  }

  // ---------- Categorização automática ----------
  const REGRAS = [
    [/salario|pagto salario|proventos|folha/, 'Salário'],
    [/supermerc|mercado|atacad|carrefour|assai|pao de acucar|hortifruti|padaria|acougue/, 'Mercado'],
    [/ifood|restaur|lanchon|burger|pizza|bar |cafe|rappi|delivery/, 'Alimentação'],
    [/uber|99 ?app|99pop|posto|combust|shell|ipiranga|petrobras|estacion|pedagio|sem parar|ipva|detran/, 'Transporte'],
    [/farmac|drogar|droga|hospital|clinica|laborat|unimed|amil|hapvida|academ|smartfit/, 'Saúde'],
    [/aluguel|condominio|iptu/, 'Moradia'],
    [/energia|enel|cemig|copel|light|celpe|coelba|sabesp|saneam|agua|gas |comgas|claro|vivo|tim |oi |internet|net servicos/, 'Contas da casa'],
    [/netflix|spotify|disney|prime video|amazon prime|hbo|max |youtube|deezer|globoplay|apple\.com|google/, 'Assinaturas'],
    [/fatura|cartao|nubank|pagamento de fatura/, 'Cartão'],
    [/escola|faculdade|curso|udemy|alura|mensalidade/, 'Educação'],
    [/rendimento|aplicacao|resgate|cdb|tesouro|invest|poupanca/, 'Investimentos'],
    [/tarifa|iof|juros|encargo|anuidade|cesta|mora /, 'Tarifas bancárias'],
    [/saque/, 'Saque'],
    [/pix|ted|doc |transf/, 'Transferências']
  ];
  function categorizar(descricao) {
    const d = ' ' + normalizar(descricao) + ' ';
    const r = REGRAS.find(([re]) => re.test(d));
    return r ? r[1] : 'Outros';
  }

  window.Extrato = { ler, categorizar, _interno: { lerOFX, lerCSV, valorCSV, dataCSV } };
})();
