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
    [/tarifa|iof|juros|anuidade|cesta/, 'Tarifas bancárias'],
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
