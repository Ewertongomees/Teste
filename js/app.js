// Panorama Financeiro — roda no navegador; os dados ficam na sua conta do claude.ai (área privada)
// e, como cópia rápida, no armazenamento do navegador.
(function () {
  'use strict';

  const CHAVE = 'panorama-financeiro-v1';
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const nomeMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

  // ---------- Estado ----------
  let estado = carregar();
  let mesVisto = hoje().slice(0, 7); // "AAAA-MM"
  let filtroEnt = ''; // '' = tudo; senão o id do titular (pessoal/empresa)
  try { filtroEnt = localStorage.getItem(CHAVE + ':titular') || ''; } catch (e) { /* sem armazenamento */ }
  if (!estado.entidades.some(e => e.id === filtroEnt)) filtroEnt = '';

  const INTERNA = 'Entre minhas contas';
  const TIPOS_ENT = { pessoal: 'Pessoal', empresa: 'Minha empresa', sociedade: 'Sociedade' };

  function entPessoal() { return { id: 'pessoal', nome: 'Pessoal', tipo: 'pessoal', participacao: null, apelidos: [] }; }
  function vazio() { return { entidades: [entPessoal()], contas: [], lancamentos: [], movimentacoes: [] }; }

  function valido(dados) {
    if (!dados || !Array.isArray(dados.contas) || !Array.isArray(dados.lancamentos)) return null;
    if (!Array.isArray(dados.movimentacoes)) dados.movimentacoes = [];
    if (!Array.isArray(dados.entidades) || !dados.entidades.length) dados.entidades = [entPessoal()];
    dados.entidades.forEach(e => { if (!Array.isArray(e.apelidos)) e.apelidos = []; });
    dados.contas.forEach(c => { if (!dados.entidades.some(e => e.id === c.entidadeId)) c.entidadeId = dados.entidades[0].id; });
    return dados;
  }

  function carregar() {
    try {
      const bruto = localStorage.getItem(CHAVE);
      if (bruto) {
        const dados = valido(JSON.parse(bruto));
        if (dados) return dados;
      }
    } catch (e) { /* armazenamento indisponível ou corrompido */ }
    return vazio();
  }

  function salvar() {
    estado.atualizadoEm = new Date().toISOString();
    try { localStorage.setItem(CHAVE, JSON.stringify(estado)); } catch (e) { /* navegador sem armazenamento: a conta guarda */ }
    agendarNuvem();
    render();
  }

  // ---------- Armazenamento na sua conta do claude.ai ----------
  // Área privada data/users/<seu id>: só você lê e grava. As movimentações vão em partes
  // (documentos de no máximo 256 KB), o resto num documento "estado".
  let nuvem = null;                 // coleção privada do usuário
  let statusNuvem = 'conectando';   // conectando | ok | salvando | indisponivel | erro
  let msgErroNuvem = '';
  const salvoNaNuvem = {};          // id do documento -> JSON já gravado (evita regravar o que não mudou)
  let partesNaNuvem = 0, tNuvem = null, gravando = false, deNovo = false;
  const TAM_PARTE = 400;
  const nomeParte = i => 'mov-' + String(i).padStart(3, '0');

  function documentosDoEstado() {
    const { movimentacoes, ...resto } = estado;
    const docs = {};
    let n = 0;
    for (let i = 0; i < movimentacoes.length; i += TAM_PARTE, n++) docs[nomeParte(n)] = JSON.stringify(movimentacoes.slice(i, i + TAM_PARTE));
    docs.estado = JSON.stringify({ ...resto, partes: n });
    return { docs, n };
  }

  function agendarNuvem() {
    if (!nuvem) return;
    clearTimeout(tNuvem);
    tNuvem = setTimeout(gravarNuvem, 700);
  }

  async function gravarNuvem() {
    if (!nuvem) return;
    if (gravando) { deNovo = true; return; }
    gravando = true;
    statusNuvem = 'salvando'; mostrarStatusNuvem();
    try {
      const { docs, n } = documentosDoEstado();
      // partes primeiro, o índice ("estado") por último, depois apaga partes que sobraram
      const ordem = Object.keys(docs).filter(k => k !== 'estado').concat('estado');
      for (const k of ordem) {
        if (salvoNaNuvem[k] === docs[k]) continue;
        await nuvem.doc(k).set({ json: docs[k], salvoEm: new Date().toISOString() });
        salvoNaNuvem[k] = docs[k];
      }
      for (let i = n; i < partesNaNuvem; i++) { await nuvem.doc(nomeParte(i)).delete(); delete salvoNaNuvem[nomeParte(i)]; }
      partesNaNuvem = n;
      statusNuvem = 'ok';
    } catch (e) {
      statusNuvem = 'erro';
      msgErroNuvem = e && e.code === 'quota_exceeded' ? 'espaço da conta esgotado' : (e && (e.message || e.code)) || 'erro';
    }
    gravando = false;
    mostrarStatusNuvem();
    if (deNovo) { deNovo = false; gravarNuvem(); }
  }

  async function conectarNuvem() {
    try {
      if (!window.claude || typeof window.claude.use !== 'function') throw new Error('fora do claude.ai');
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      const uid = user ? await user.id() : null;
      if (!db || !uid) throw new Error('indisponível');
      const col = db.collection('data/users/' + uid);
      const snap = await col.get();
      const docs = {};
      snap.docs.forEach(d => { if (d.exists) docs[d.id] = d.data(); });
      nuvem = col;
      Object.entries(docs).forEach(([k, v]) => { salvoNaNuvem[k] = v.json; });
      let daNuvem = null;
      if (docs.estado) {
        const resto = JSON.parse(docs.estado.json);
        partesNaNuvem = resto.partes || 0;
        const movs = [];
        for (let i = 0; i < partesNaNuvem; i++) if (docs[nomeParte(i)]) movs.push(...JSON.parse(docs[nomeParte(i)].json));
        delete resto.partes;
        daNuvem = valido({ ...resto, movimentacoes: movs });
      }
      const localTemDados = estado.movimentacoes.length || estado.contas.length || estado.lancamentos.length;
      if (daNuvem && (!localTemDados || (daNuvem.atualizadoEm || '') >= (estado.atualizadoEm || ''))) {
        estado = daNuvem;                                   // a conta é a fonte principal
        if (!estado.entidades.some(e => e.id === filtroEnt)) filtroEnt = '';
        try { localStorage.setItem(CHAVE, JSON.stringify(estado)); } catch (e) { /* ok */ }
        statusNuvem = 'ok';
        render();
      } else if (localTemDados) {
        statusNuvem = 'ok';
        await gravarNuvem();                                // leva os dados deste navegador para a conta
      } else statusNuvem = 'ok';
    } catch (e) {
      nuvem = null;
      statusNuvem = 'indisponivel';
    }
    mostrarStatusNuvem();
  }

  function mostrarStatusNuvem() {
    const el = document.getElementById('statusNuvem');
    if (!el) return;
    const txt = {
      conectando: '☁ Conectando à sua conta…',
      ok: '☁ Salvo na sua conta',
      salvando: '☁ Salvando…',
      indisponivel: '⚠ Salvo só neste navegador',
      erro: '⚠ Não salvou na conta' + (msgErroNuvem ? ' (' + msgErroNuvem + ')' : '')
    }[statusNuvem];
    el.textContent = txt;
    el.className = 'status-nuvem ' + statusNuvem;
    el.title = statusNuvem === 'ok' ? 'Seus dados ficam numa área privada da sua conta e aparecem em qualquer aparelho.'
      : statusNuvem === 'indisponivel' ? 'Abra o app pelo link do claude.ai para salvar na sua conta.' : '';
  }

  // ---------- Caixas de diálogo dentro da página (as do navegador podem estar bloqueadas) ----------
  function perguntar(mensagem, { ok = 'OK', cancelar = 'Cancelar', campo = null } = {}) {
    return new Promise(resolve => {
      const fundo = document.createElement('div');
      fundo.className = 'modal-fundo';
      fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><p class="modal-msg"></p>` +
        (campo !== null ? '<input class="modal-campo" inputmode="decimal">' : '') +
        `<div class="acoes">${cancelar ? '<button type="button" class="secundario" data-r="0"></button>' : ''}<button type="button" data-r="1"></button></div></div>`;
      fundo.querySelector('.modal-msg').textContent = mensagem;
      fundo.querySelector('[data-r="1"]').textContent = ok;
      if (cancelar) fundo.querySelector('[data-r="0"]').textContent = cancelar;
      const inp = fundo.querySelector('.modal-campo');
      if (inp) inp.value = campo;
      const fechar = sim => {
        fundo.remove();
        document.removeEventListener('keydown', tecla, true);
        resolve(inp ? (sim ? inp.value : null) : sim);
      };
      const tecla = e => {
        if (e.key === 'Escape') { e.preventDefault(); fechar(false); }
        if (e.key === 'Enter') { e.preventDefault(); fechar(true); }
      };
      fundo.addEventListener('click', e => {
        const b = e.target.closest('[data-r]');
        if (b) { e.stopPropagation(); fechar(b.dataset.r === '1'); }
      });
      document.addEventListener('keydown', tecla, true);
      document.body.appendChild(fundo);
      (inp || fundo.querySelector('[data-r="1"]')).focus();
    });
  }
  const avisar = msg => perguntar(msg, { cancelar: null });

  // Baixar um arquivo: pelo recurso de downloads do claude.ai quando disponível, senão pelo navegador
  async function baixar(nome, conteudo, tipo) {
    try {
      const dl = window.claude && typeof window.claude.use === 'function' ? await window.claude.use('downloads') : null;
      if (dl) { await dl.save({ filename: nome, data: new Blob([conteudo], { type: tipo }) }); return; }
    } catch (e) {
      if (e && e.code === 'declined') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Utilidades ----------
  function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function hoje() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function dataBR(iso) { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; }
  function fimDoMes(mes) {
    const [a, m] = mes.split('-').map(Number);
    const ultimo = new Date(a, m, 0).getDate();
    return `${mes}-${String(ultimo).padStart(2, '0')}`;
  }
  function somaMes(mes, n) {
    const [a, m] = mes.split('-').map(Number);
    const d = new Date(a, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // Próxima data mensal mantendo o dia original (31 → 30/28 → 31...)
  function proximaData(iso, diaOriginal) {
    const mes = somaMes(iso.slice(0, 7), 1);
    const ultimo = Number(fimDoMes(mes).slice(8));
    const dia = Math.min(diaOriginal || Number(iso.slice(8)), ultimo);
    return `${mes}-${String(dia).padStart(2, '0')}`;
  }
  function nomeConta(contaId) {
    const c = estado.contas.find(c => c.id === contaId);
    return c ? c.nome : '—';
  }
  function contasVisiveis() { return estado.contas.filter(c => !filtroEnt || c.entidadeId === filtroEnt); }
  function idsVisiveis() { return new Set(contasVisiveis().map(c => c.id)); }
  function lancVisiveis() { const ids = idsVisiveis(); return estado.lancamentos.filter(l => !filtroEnt || ids.has(l.contaId)); }
  function movVisiveis() { const ids = idsVisiveis(); return estado.movimentacoes.filter(m => !filtroEnt || ids.has(m.contaId)); }
  function saldoTotal() { return contasVisiveis().reduce((s, c) => s + c.saldo, 0); }
  function entidade(idEnt) { return estado.entidades.find(e => e.id === idEnt) || estado.entidades[0]; }
  // Quanto do saldo é seu: em sociedade, só a sua participação
  function suaParte(c) {
    const e = entidade(c.entidadeId);
    return e.tipo === 'sociedade' && Number.isFinite(e.participacao) ? c.saldo * e.participacao / 100 : c.saldo;
  }

  // Nomes (de pessoas e empresas) normalizados para reconhecer transferências entre as suas contas
  function normNome(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(ltda|me|epp|eireli|s\/?a|s\.a\.?)\b\.?/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function nomesProprios() {
    return estado.entidades.flatMap(e => [e.tipo === 'pessoal' ? '' : e.nome, ...e.apelidos]).map(normNome).filter(n => n.length >= 6);
  }
  function ehInterna(descricao, nomes = nomesProprios()) {
    const d = ' ' + normNome(descricao) + ' ';
    return nomes.some(n => d.includes(' ' + n + ' '));
  }
  function recategorizarInternas() {
    const nomes = nomesProprios();
    let n = 0;
    for (const m of estado.movimentacoes) {
      if (m.categoria !== INTERNA && !m.categoriaManual && ehInterna(m.descricao, nomes)) { m.categoria = INTERNA; n++; }
    }
    return n;
  }
  function sinal(l) { return l.tipo === 'receber' ? 1 : -1; }

  // Lançamentos reais + projeções das recorrências até a data limite.
  function ocorrenciasAte(limite) {
    const lista = estado.lancamentos.map(l => ({ ...l, virtual: false }));
    for (const l of estado.lancamentos) {
      if (!l.recorrente || l.proximaGerada) continue;
      let data = proximaData(l.vencimento, l.diaOriginal);
      while (data <= limite) {
        lista.push({ ...l, id: l.id + ':' + data, vencimento: data, pago: false, virtual: true });
        data = proximaData(data, l.diaOriginal);
      }
    }
    return lista;
  }

  // ---------- Ações ----------
  function marcarPago(lancId) {
    const l = estado.lancamentos.find(x => x.id === lancId);
    if (!l || l.pago) return;
    darBaixa(l, true, hoje());
    salvar();
  }

  // Marca como pago; ajustarSaldo=false quando o saldo já veio do extrato do banco.
  function darBaixa(l, ajustarSaldo, data) {
    l.pago = true;
    l.dataPagamento = data;
    l.conciliado = !ajustarSaldo;
    const conta = estado.contas.find(c => c.id === l.contaId);
    if (conta && ajustarSaldo) conta.saldo = arred(conta.saldo + sinal(l) * l.valor);
    if (l.recorrente && !l.proximaGerada) {
      l.proximaGerada = true;
      estado.lancamentos.push({
        ...l, id: id(), vencimento: proximaData(l.vencimento, l.diaOriginal),
        pago: false, dataPagamento: null, proximaGerada: false, conciliado: false, movId: null
      });
    }
  }

  function desfazerPago(lancId) {
    const l = estado.lancamentos.find(x => x.id === lancId);
    if (!l || !l.pago) return;
    const conta = estado.contas.find(c => c.id === l.contaId);
    if (conta && !l.conciliado) conta.saldo = arred(conta.saldo - sinal(l) * l.valor);
    if (l.movId) {
      const mov = estado.movimentacoes.find(m => m.id === l.movId);
      if (mov) mov.lancId = null;
    }
    l.pago = false;
    l.dataPagamento = null;
    l.conciliado = false;
    l.movId = null;
    salvar();
  }

  // ---------- Importação de extrato ----------
  function diasEntre(a, b) { return Math.abs((new Date(a) - new Date(b)) / 86400000); }

  function pareceEmpresa(nome) {
    return /\b(ltda|me|epp|eireli|s\/?a|s\.a|construtora|comercio|servicos|industria|estruturas|empreendimentos|cnpj)\b/i.test(normNome(nome) + ' ' + nome);
  }
  function tituloCaso(s) {
    return s.toLowerCase().replace(/\b(ltda|me|epp|eireli)\b\.?/g, '').trim()
      .replace(/(^|\s)\S/g, c => c.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, w => w.toLowerCase())
      .replace(/^\S{2,4}(?=\s|$)/, w => w.toUpperCase()); // siglas no começo: EWG, EGE
  }

  // Descobre (ou cria) o titular e a conta a partir do cabeçalho do extrato
  async function contaAutomatica(info) {
    const titular = (info.titular || '').trim();
    const banco = info.banco || 'Banco';
    let ent = null;
    if (titular) {
      const n = normNome(titular);
      ent = estado.entidades.find(e => [e.nome, ...e.apelidos].some(a => normNome(a) === n));
      if (!ent && pareceEmpresa(titular)) {
        const nome = tituloCaso(titular);
        const soc = await perguntar(`Encontrei a empresa "${titular}" no extrato.\n\nEla tem outros sócios além de você?`,
          { ok: 'Sim, tem sócios', cancelar: 'Não, é só minha' });
        let participacao = null;
        if (soc) {
          const resp = await perguntar(`Qual é a sua participação na ${nome}, em %? (deixe em branco se não souber agora)`, { campo: '', ok: 'Salvar' });
          const v = Number(String(resp || '').replace(',', '.').replace('%', ''));
          participacao = resp && Number.isFinite(v) && v > 0 && v <= 100 ? v : null;
        }
        ent = { id: id(), nome, tipo: soc ? 'sociedade' : 'empresa', participacao, apelidos: [titular] };
        estado.entidades.push(ent);
      }
      if (!ent) {
        ent = estado.entidades.find(e => e.tipo === 'pessoal') || estado.entidades[0];
        if (!ent.apelidos.some(a => normNome(a) === n)) ent.apelidos.push(titular);
      }
    }
    if (!ent) ent = estado.entidades.find(e => e.tipo === 'pessoal') || estado.entidades[0];
    let conta = estado.contas.find(c => c.banco === banco && c.entidadeId === ent.id && (!c.titular || !titular || normNome(c.titular) === normNome(titular)));
    if (!conta) {
      conta = { id: id(), nome: ent.tipo === 'pessoal' ? banco : `${banco} · ${ent.nome}`, tipo: 'Conta corrente', saldo: 0,
        entidadeId: ent.id, banco, titular };
      estado.contas.push(conta);
    }
    return conta;
  }

  // Caixa "De qual conta é este extrato?" — escolhe uma conta existente ou cria uma nova
  function escolherConta(nomeArquivo, r) {
    return new Promise(resolve => {
      const datas = r.transacoes.map(t => t.data).sort();
      const fundo = document.createElement('div');
      fundo.className = 'modal-fundo';
      fundo.innerHTML = `<form class="modal formulario-modal">
        <h2>De qual conta é este extrato?</h2>
        <p class="dica"></p>
        <label>Conta <select name="conta"></select></label>
        <div class="nova">
          <label>Nome da conta nova <input name="nome" placeholder="Ex.: Caixa"></label>
          <label>Titular <select name="titular"></select></label>
        </div>
        <div class="acoes"><button type="button" class="secundario" data-r="0">Cancelar</button><button type="submit">Importar</button></div>
      </form>`;
      const f = fundo.querySelector('form');
      f.querySelector('.dica').textContent = `${nomeArquivo}: ${r.transacoes.length} movimentação(ões)` +
        (datas.length ? ` de ${dataBR(datas[0])} a ${dataBR(datas[datas.length - 1])}` : '') +
        (r.saldo !== null ? `, saldo ${brl.format(r.saldo)}` : '') + '. O arquivo não diz de qual banco ou titular é.';
      f.conta.innerHTML = estado.contas.map(c => `<option value="${c.id}">${esc(c.nome)} (${esc(entidade(c.entidadeId).nome)})</option>`).join('') +
        '<option value="__nova">+ Criar conta nova…</option>';
      f.conta.value = estado.contas.length ? estado.contas[0].id : '__nova';
      f.titular.innerHTML = estado.entidades.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('');
      f.titular.value = filtroEnt || (estado.entidades.find(e => e.tipo === 'pessoal') || estado.entidades[0]).id;
      const atualizar = () => { f.querySelector('.nova').hidden = f.conta.value !== '__nova'; };
      f.conta.addEventListener('change', atualizar); atualizar();
      const fechar = v => { fundo.remove(); resolve(v); };
      f.querySelector('[data-r="0"]').addEventListener('click', e => { e.stopPropagation(); fechar(null); });
      f.addEventListener('submit', e => {
        e.preventDefault();
        if (f.conta.value !== '__nova') return fechar({ conta: estado.contas.find(c => c.id === f.conta.value), nova: false });
        const nome = f.nome.value.trim();
        if (!nome) { f.nome.focus(); return; }
        const conta = { id: id(), nome, tipo: 'Conta corrente', saldo: 0, entidadeId: f.titular.value, banco: nome, titular: '' };
        estado.contas.push(conta);
        fechar({ conta, nova: true });
      });
      document.body.appendChild(fundo);
      (f.conta.value === '__nova' ? f.nome : f.conta).focus();
    });
  }

  async function importarExtrato(contaId, arquivo) {
    let conta = estado.contas.find(c => c.id === contaId);
    if (!conta && contaId !== '__auto') throw new Error('Escolha a conta do banco antes de importar.');
    const r = await window.Extrato.ler(arquivo);
    let contaNova = false;
    if (!conta && !(r.info && r.info.titular)) {
      // O arquivo não diz de quem é a conta (ex.: print do app do banco): pergunta
      const escolha = await escolherConta(arquivo.name, r);
      if (!escolha) throw new Error('Importação cancelada.');
      conta = escolha.conta; contaNova = escolha.nova;
    }
    if (!conta) { const n = estado.contas.length; conta = await contaAutomatica(r.info || {}); contaNova = estado.contas.length > n; }
    contaId = conta.id;
    const nomes = nomesProprios();

    const chave = t => t.fitid ? 'f:' + t.fitid : `d:${t.data}|${t.valor}|${t.descricao}`;
    const existentes = new Set(estado.movimentacoes.filter(m => m.contaId === contaId).map(chave));
    const novas = [];
    for (const t of r.transacoes) {
      const k = chave(t);
      if (existentes.has(k)) continue;
      existentes.add(k);
      const categoria = ehInterna(t.descricao, nomes) ? INTERNA : window.Extrato.categorizar(t.descricao);
      novas.push({ id: id(), contaId, ...t, categoria, lancId: null });
    }

    // Conciliação: dá baixa nas contas a pagar/receber que aparecem no extrato
    let conciliadas = 0;
    for (const m of novas) {
      const tipo = m.valor < 0 ? 'pagar' : 'receber';
      const l = estado.lancamentos
        .filter(l => !l.pago && l.tipo === tipo && (!l.contaId || l.contaId === contaId) &&
          Math.abs(l.valor - Math.abs(m.valor)) < 0.01 && diasEntre(l.vencimento, m.data) <= 7)
        .sort((x, y) => diasEntre(x.vencimento, m.data) - diasEntre(y.vencimento, m.data))[0];
      if (l) {
        l.contaId = contaId;
        darBaixa(l, false, m.data);
        l.movId = m.id;
        m.lancId = l.id;
        m.categoria = l.categoria || m.categoria;
        conciliadas++;
      }
    }

    estado.movimentacoes.push(...novas);

    // Atualização do saldo
    let msgSaldo = '';
    if (r.saldo !== null && conta.dataSaldo && r.dataSaldo && r.dataSaldo < conta.dataSaldo) {
      // extrato mais antigo que o último saldo conhecido: não volta o saldo para trás
      msgSaldo = ` Saldo mantido (${brl.format(conta.saldo)} em ${dataBR(conta.dataSaldo)}, mais recente que este extrato).`;
    } else if (r.saldo !== null && (contaNova || (conta.dataSaldo && r.dataSaldo))) {
      conta.saldo = r.saldo; // conta nova, ou extrato mais novo que o último: vale o saldo do banco
      conta.dataSaldo = r.dataSaldo || conta.dataSaldo;
      msgSaldo = ` Saldo: ${brl.format(r.saldo)}${r.dataSaldo ? ' em ' + dataBR(r.dataSaldo) : ''}.`;
    } else if (r.saldo !== null) {
      if (Math.abs(r.saldo - conta.saldo) >= 0.01 &&
          await perguntar(`O banco informou saldo de ${brl.format(r.saldo)}${r.dataSaldo ? ' em ' + dataBR(r.dataSaldo) : ''}.\n` +
                  `O saldo cadastrado de "${conta.nome}" é ${brl.format(conta.saldo)}.\n\nAtualizar para o saldo do banco?`, { ok: 'Atualizar', cancelar: 'Manter' })) {
        conta.saldo = r.saldo;
        conta.dataSaldo = r.dataSaldo || null;
        msgSaldo = ` Saldo atualizado para ${brl.format(r.saldo)}.`;
      }
    } else if (novas.length) {
      const total = arred(novas.reduce((s, m) => s + m.valor, 0));
      if (await perguntar(`${novas.length === 1 ? "A movimentação nova soma" : `As ${novas.length} movimentações novas somam`} ${brl.format(total)}.\n\n` +
                  `Aplicar esse valor ao saldo de "${conta.nome}" (${brl.format(conta.saldo)} → ${brl.format(arred(conta.saldo + total))})?\n\n` +
                  'Escolha "Manter" se o saldo cadastrado já considera essas movimentações.', { ok: 'Aplicar', cancelar: 'Manter' })) {
        conta.saldo = arred(conta.saldo + total);
        msgSaldo = ` Saldo atualizado para ${brl.format(conta.saldo)}.`;
      }
    }
    conta.ultimaImportacao = hoje();
    recategorizarInternas();
    salvar();

    const ignoradas = r.transacoes.length - novas.length;
    return `${r.formato} → ${conta.nome} (${entidade(conta.entidadeId).nome}): ${novas.length} movimentação(ões) importada(s)` +
      (ignoradas ? `, ${ignoradas} já existia(m)` : '') +
      (conciliadas ? `, ${conciliadas} conta(s) a pagar/receber baixada(s) automaticamente` : '') + '.' + msgSaldo;
  }

  function arred(v) { return Math.round(v * 100) / 100; }

  // ---------- Renderização ----------
  function render() {
    document.getElementById('semDados').hidden = estado.movimentacoes.length > 0;
    renderFiltroEnt();
    renderEntidades();
    renderPainel();
    renderLancamentos();
    renderContas();
    renderSelects();
    renderExtrato();
  }

  function renderPainel() {
    const inicio = `${mesVisto}-01`;
    const fim = fimDoMes(mesVisto);
    const hj = hoje();
    const [a, m] = mesVisto.split('-').map(Number);
    const rotulo = nomeMes.format(new Date(a, m - 1, 1));
    document.getElementById('mesAtual').textContent = rotulo.charAt(0).toUpperCase() + rotulo.slice(1);

    const ocorr = ocorrenciasAte(fim).filter(l => !filtroEnt || idsVisiveis().has(l.contaId));
    const doMes = ocorr.filter(l => l.vencimento >= inicio && l.vencimento <= fim);
    const pendDoMes = doMes.filter(l => !l.pago);
    const somar = arr => arr.reduce((s, l) => s + l.valor, 0);

    const receber = somar(pendDoMes.filter(l => l.tipo === 'receber'));
    const pagar = somar(pendDoMes.filter(l => l.tipo === 'pagar'));
    // Previsto: saldo de hoje + tudo que ainda está pendente até o fim do mês visto (inclui atrasados)
    const pendAteFim = ocorr.filter(l => !l.pago && l.vencimento <= fim);
    const previsto = saldoTotal() + pendAteFim.reduce((s, l) => s + sinal(l) * l.valor, 0);

    setValor('kSaldo', saldoTotal());
    const parte = contasVisiveis().reduce((s, c) => s + suaParte(c), 0);
    const nota = document.getElementById('kSaldoNota');
    const temSoc = contasVisiveis().some(c => entidade(c.entidadeId).tipo === 'sociedade');
    nota.textContent = temSoc ? (Math.abs(parte - saldoTotal()) >= 0.01 ? `Sua parte (descontando sócios): ${brl.format(parte)}` : 'Defina sua % nas sociedades para ver a sua parte') : '';
    document.getElementById('kReceber').textContent = brl.format(receber);
    document.getElementById('kPagar').textContent = brl.format(pagar);
    setValor('kPrevisto', previsto);

    // Alerta de vencidas
    const vencidas = lancVisiveis().filter(l => !l.pago && l.tipo === 'pagar' && l.vencimento < hj);
    const alerta = document.getElementById('alertaVencidas');
    if (vencidas.length) {
      alerta.hidden = false;
      alerta.innerHTML = `<strong>Atenção:</strong> ${vencidas.length} conta(s) vencida(s), totalizando ${brl.format(somar(vencidas))}.`;
    } else {
      alerta.hidden = true;
    }

    // Próximos vencimentos (pendentes reais, a partir de hoje e atrasados)
    const proximos = lancVisiveis().filter(l => !l.pago)
      .sort((x, y) => x.vencimento.localeCompare(y.vencimento)).slice(0, 8);
    const ulProx = document.getElementById('listaProximos');
    ulProx.innerHTML = proximos.length ? proximos.map(l => `
      <li>
        <div>${esc(l.descricao)}<small>${dataBR(l.vencimento)} · ${statusTexto(l)}</small></div>
        <div class="acoes">
          <span class="valor ${l.tipo === 'receber' ? 'pos' : 'neg'}">${brl.format(l.valor)}</span>
          <button class="mini" data-pagar="${l.id}">${l.tipo === 'receber' ? 'Recebi' : 'Paguei'}</button>
        </div>
      </li>`).join('') : '<li class="vazio">Nenhuma conta pendente. 🎉</li>';

    // Despesas por categoria
    const porCat = {};
    for (const l of doMes.filter(l => l.tipo === 'pagar')) {
      const c = l.categoria || 'Sem categoria';
      porCat[c] = (porCat[c] || 0) + l.valor;
    }
    // + gastos vindos do extrato do banco (os já conciliados com uma conta a pagar não contam de novo)
    // Na visão "Tudo", dinheiro que só passou de uma conta sua para outra não é gasto
    for (const m of movVisiveis()) {
      if (m.valor >= 0 || m.lancId || m.data < inicio || m.data > fim) continue;
      if (!filtroEnt && m.categoria === INTERNA) continue;
      const c = m.categoria || 'Outros';
      porCat[c] = (porCat[c] || 0) - m.valor;
    }
    const cats = Object.entries(porCat).sort((x, y) => y[1] - x[1]);
    const max = cats.length ? cats[0][1] : 0;
    document.getElementById('graficoCategorias').innerHTML = cats.length ? cats.map(([c, v]) => `
      <div class="barra">
        <div class="rotulo"><span>${esc(c)}</span><span>${brl.format(v)}</span></div>
        <div class="trilho"><div class="preenchido" style="width:${(v / max * 100).toFixed(1)}%"></div></div>
      </div>`).join('') : '<p class="vazio">Sem despesas neste mês.</p>';

    // Saldo por conta, agrupado por titular
    const ulSaldos = document.getElementById('listaSaldos');
    const visiveis = contasVisiveis();
    ulSaldos.innerHTML = visiveis.length ? estado.entidades.map(e => {
      const cs = visiveis.filter(c => c.entidadeId === e.id);
      if (!cs.length) return '';
      const total = cs.reduce((s, c) => s + c.saldo, 0);
      const parteTxt = e.tipo === 'sociedade' && Number.isFinite(e.participacao)
        ? ` · sua parte (${String(e.participacao).replace('.', ',')}%): ${brl.format(total * e.participacao / 100)}` : '';
      return `<li class="grupo"><div><strong>${esc(e.nome)}</strong><small>${e.tipo === 'pessoal' ? '' : TIPOS_ENT[e.tipo]}${parteTxt}</small></div>
          <span class="valor ${total < 0 ? 'neg' : ''}"><strong>${brl.format(total)}</strong></span></li>` +
        cs.map(c => `
      <li class="sub"><div>${esc(c.nome)}<small>${esc(c.tipo)}${c.ultimaImportacao ? ' · extrato de ' + dataBR(c.ultimaImportacao) : ''}</small></div>
      <span class="valor ${c.saldo < 0 ? 'neg' : ''}">${brl.format(c.saldo)}</span></li>`).join('');
    }).join('')
      : '<li class="vazio">Cadastre suas contas ou importe um extrato na aba “Contas e saldos”.</li>';
  }

  function setValor(elId, v) {
    const el = document.getElementById(elId);
    el.textContent = brl.format(v);
    el.className = v < 0 ? 'neg' : '';
  }

  function statusTexto(l) {
    if (l.pago) return (l.tipo === 'receber' ? 'Recebido' : 'Pago') + (l.conciliado ? ' (extrato)' : '');
    if (l.vencimento < hoje()) return 'Vencida';
    if (l.vencimento === hoje()) return 'Vence hoje';
    return 'Pendente';
  }

  function renderLancamentos() {
    const status = document.getElementById('filtroStatus').value;
    const tipo = document.getElementById('filtroTipo').value;
    const hj = hoje();
    let lista = lancVisiveis().filter(l => !tipo || l.tipo === tipo);
    if (status === 'pendentes') lista = lista.filter(l => !l.pago);
    if (status === 'vencidas') lista = lista.filter(l => !l.pago && l.vencimento < hj);
    if (status === 'pagas') lista = lista.filter(l => l.pago);
    lista.sort((x, y) => status === 'pagas' ? y.vencimento.localeCompare(x.vencimento) : x.vencimento.localeCompare(y.vencimento));

    document.getElementById('tabelaLanc').innerHTML = lista.length ? lista.map(l => {
      const st = statusTexto(l);
      const cls = l.pago ? 'paga' : (st === 'Vencida' ? 'vencida' : 'pendente');
      return `<tr>
        <td>${dataBR(l.vencimento)}</td>
        <td>${esc(l.descricao)}${l.recorrente ? ' <small title="Mensal">🔁</small>' : ''}</td>
        <td>${esc(l.categoria || '—')}</td>
        <td>${esc(nomeConta(l.contaId))}</td>
        <td class="num ${l.tipo === 'receber' ? 'pos' : 'neg'}">${l.tipo === 'receber' ? '+' : '−'} ${brl.format(l.valor)}</td>
        <td><span class="etiqueta ${cls}">${st}</span></td>
        <td><div class="acoes">
          ${l.pago
            ? `<button class="mini secundario" data-desfazer="${l.id}">Desfazer</button>`
            : `<button class="mini" data-pagar="${l.id}">${l.tipo === 'receber' ? 'Recebi' : 'Paguei'}</button>`}
          <button class="mini secundario" data-editar-lanc="${l.id}">Editar</button>
          <button class="mini perigo" data-excluir-lanc="${l.id}">Excluir</button>
        </div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="vazio">Nada por aqui.</td></tr>';
  }

  function renderContas() {
    const ul = document.getElementById('listaContas');
    const visiveis = contasVisiveis();
    ul.innerHTML = visiveis.length ? visiveis.map(c => `
      <li>
        <div><strong>${esc(c.nome)}</strong><small>${esc(entidade(c.entidadeId).nome)} · ${esc(c.tipo)}${c.ultimaImportacao ? ' · último extrato importado em ' + dataBR(c.ultimaImportacao) : ''}</small></div>
        <div class="acoes">
          <span class="valor ${c.saldo < 0 ? 'neg' : ''}">${brl.format(c.saldo)}</span>
          <button class="mini" data-importar="${c.id}">Importar extrato</button>
          <button class="mini secundario" data-editar-conta="${c.id}">Editar</button>
          <button class="mini perigo" data-excluir-conta="${c.id}">Excluir</button>
        </div>
      </li>`).join('') + `<li><strong>Total</strong><span class="valor"><strong>${brl.format(saldoTotal())}</strong></span></li>`
      : '<li class="vazio">Nenhuma conta cadastrada ainda.</li>';
  }

  function renderSelects() {
    const sel = document.querySelector('#formLanc [name=contaId]');
    const atual = sel.value;
    sel.innerHTML = '<option value="">(nenhuma)</option>' +
      estado.contas.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
    sel.value = estado.contas.some(c => c.id === atual) ? atual : (estado.contas[0]?.id || '');

    const cats = [...new Set([...estado.lancamentos, ...estado.movimentacoes].map(l => l.categoria).filter(Boolean))].sort();
    document.getElementById('categorias').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');

    const sImp = document.getElementById('contaImport');
    const vImp = sImp.value;
    sImp.innerHTML = '<option value="__auto">Detectar pelo extrato (cria a conta se precisar)</option>' +
      estado.contas.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
    if ([...sImp.options].some(o => o.value === vImp)) sImp.value = vImp;

    // Banco / conta do extrato: todos, um banco inteiro (todas as contas dele) ou uma conta
    const sB = document.getElementById('fBanco');
    const vB = sB.value;
    const visiveis = contasVisiveis();
    const bancos = [...new Set(visiveis.map(bancoDe))].sort();
    sB.innerHTML = '<option value="">Todos os bancos</option>' +
      (bancos.length ? '<optgroup label="Banco (todas as contas)">' +
        bancos.map(b => `<option value="b:${esc(b)}">${esc(b)} · ${visiveis.filter(c => bancoDe(c) === b).length} conta(s)</option>`).join('') + '</optgroup>' : '') +
      (visiveis.length ? '<optgroup label="Uma conta">' +
        visiveis.map(c => `<option value="c:${c.id}">${esc(c.nome)}${filtroEnt ? '' : ' (' + esc(entidade(c.entidadeId).nome) + ')'}</option>`).join('') + '</optgroup>' : '');
    sB.value = [...sB.options].some(o => o.value === vB) ? vB : '';

    const selEnt = formConta.entidadeId;
    const vEnt = selEnt.value;
    selEnt.innerHTML = estado.entidades.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('');
    selEnt.value = estado.entidades.some(e => e.id === vEnt) ? vEnt : (filtroEnt || estado.entidades[0].id);
  }

  function renderFiltroEnt() {
    const sel = document.getElementById('filtroEntidade');
    sel.innerHTML = '<option value="">Tudo (pessoal + empresas)</option>' +
      estado.entidades.map(e => `<option value="${e.id}">${esc(e.nome)}${e.tipo !== 'pessoal' ? ' · ' + TIPOS_ENT[e.tipo] : ''}</option>`).join('');
    sel.value = filtroEnt;
  }

  function renderEntidades() {
    document.getElementById('listaEntidades').innerHTML = estado.entidades.map(e => {
      const n = estado.contas.filter(c => c.entidadeId === e.id).length;
      const extra = e.tipo === 'sociedade' ? (Number.isFinite(e.participacao) ? ` · sua parte: ${String(e.participacao).replace('.', ',')}%` : ' · defina sua %') : '';
      return `<li>
        <div><strong>${esc(e.nome)}</strong><small>${TIPOS_ENT[e.tipo]}${extra} · ${n} conta(s)${e.apelidos.length ? ' · nos extratos: ' + esc(e.apelidos.join(', ')) : ''}</small></div>
        <div class="acoes">
          <button class="mini secundario" data-editar-ent="${e.id}">Editar</button>
          ${estado.entidades.length > 1 ? `<button class="mini perigo" data-excluir-ent="${e.id}">Excluir</button>` : ''}
        </div>
      </li>`;
    }).join('');
  }

  // ---------- Extrato: fornecedores, filtros e resumo ----------
  function bancoDe(c) { return c.banco || c.nome; }

  // Agrupa as variações do mesmo nome (maiúsculas, LTDA/ME, nomes cortados pelo banco)
  let cacheGrupos = { chave: '', mapa: null };
  function gruposContraparte() {
    const chaveCache = estado.movimentacoes.length + '|' + (estado.movimentacoes[0] || {}).id + '|' + (estado.movimentacoes[estado.movimentacoes.length - 1] || {}).id;
    if (cacheGrupos.chave === chaveCache) return cacheGrupos.mapa;
    const contagem = {}; // chave normalizada -> { variações: {nome: n}, n }
    const chaveDe = nome => normNome(nome).replace(/\b\d{6,}\b/g, '').replace(/\s+/g, ' ').trim();
    for (const m of estado.movimentacoes) {
      const nome = rotuloMov(m);
      const k = chaveDe(nome);
      if (!k) continue;
      const g = contagem[k] || (contagem[k] = { variacoes: {}, n: 0 });
      g.variacoes[nome] = (g.variacoes[nome] || 0) + 1;
      g.n++;
    }
    // nome cortado ("RAFAEL CLEITON OLIVEI") -> nome completo que começa igual
    const chaves = Object.keys(contagem).sort((a, b) => b.length - a.length);
    const destino = {};
    for (const k of chaves) {
      if (k.length < 12) { destino[k] = k; continue; }
      const maior = chaves.filter(L => L.length > k.length && L.startsWith(k) && destino[L] === L)
        .sort((a, b) => contagem[b].n - contagem[a].n)[0];
      destino[k] = maior || k;
    }
    const mapa = {}; // chave -> { chave final, nome de exibição }
    const finais = {};
    for (const k of chaves) {
      const f = destino[k];
      const g = finais[f] || (finais[f] = { variacoes: {}, n: 0 });
      Object.entries(contagem[k].variacoes).forEach(([v, n]) => { g.variacoes[v] = (g.variacoes[v] || 0) + n; });
      g.n += contagem[k].n;
    }
    for (const [f, g] of Object.entries(finais)) {
      // exibe a forma mais completa; empate: a mais usada
      const vs = Object.entries(g.variacoes).sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
      g.nome = vs[0][0];
    }
    for (const k of chaves) mapa[k] = { chave: destino[k], nome: finais[destino[k]].nome };
    const resultado = { chaveDe, mapa, finais };
    cacheGrupos = { chave: chaveCache, mapa: resultado };
    return resultado;
  }
  // Nome do fornecedor/cliente, ou a própria descrição resumida (tarifas, saques, rendimentos...)
  function rotuloMov(m) {
    return window.Extrato.contraparte(m.descricao) ||
      m.descricao.replace(/\s+-\s+.*$/, '').replace(/\s+\d[\d.,/%]*$/, '').trim() || m.descricao;
  }
  function fornecedorDe(m) {
    const g = gruposContraparte();
    const info = g.mapa[g.chaveDe(rotuloMov(m))];
    return info || { chave: '', nome: rotuloMov(m) };
  }

  function periodoSelecionado() {
    const v = document.getElementById('fPeriodo').value;
    const hj = hoje(), mes = hj.slice(0, 7);
    switch (v) {
      case 'mes': return [mes + '-01', fimDoMes(mes)];
      case 'mesPassado': { const m = somaMes(mes, -1); return [m + '-01', fimDoMes(m)]; }
      case '3m': return [somaMes(mes, -2) + '-01', hj];
      case 'ano': return [hj.slice(0, 4) + '-01-01', hj];
      case '12m': return [somaMes(mes, -11) + '-01', hj];
      case 'custom': return [document.getElementById('fDe').value || '0000', document.getElementById('fAte').value || '9999'];
      default: return ['0000', '9999'];
    }
  }

  let limiteTabela = 200, limiteRanking = 10;

  function filtrarExtrato() {
    const banco = document.getElementById('fBanco').value;
    const tipo = document.getElementById('fTipo').value;
    const busca = document.getElementById('fBusca').value.trim();
    const [de, ate] = periodoSelecionado();
    const g = gruposContraparte();
    const chaveBusca = busca ? (g.mapa[g.chaveDe(busca)] || {}).chave : '';
    const termo = normNome(busca);
    // Sem busca, transferências entre as suas próprias contas ficam de fora (não são fornecedores nem clientes)
    const semInternas = !busca && !document.getElementById('fInternas').checked;
    const contaOk = banco.startsWith('c:') ? (m => m.contaId === banco.slice(2))
      : banco.startsWith('b:') ? (() => { const ids = new Set(estado.contas.filter(c => bancoDe(c) === banco.slice(2)).map(c => c.id)); return m => ids.has(m.contaId); })()
      : () => true;
    const lista = movVisiveis().filter(m => {
      if (!contaOk(m)) return false;
      if (tipo === 'saida' && m.valor >= 0) return false;
      if (tipo === 'entrada' && m.valor <= 0) return false;
      if (m.data < de || m.data > ate) return false;
      if (semInternas && m.categoria === INTERNA) return false;
      if (busca) {
        const f = fornecedorDe(m);
        if (chaveBusca) return f.chave === chaveBusca;           // nome escolhido da lista: só esse fornecedor
        return normNome(f.nome).includes(termo) || normNome(m.descricao).includes(termo);
      }
      return true;
    }).sort((a, b) => b.data.localeCompare(a.data));
    return { lista, chaveBusca, busca, tipo };
  }

  function barras(pares, cls = '') {
    if (!pares.length) return '<p class="vazio">Nada no filtro.</p>';
    const max = Math.max(...pares.map(p => Math.abs(p[1])));
    return pares.map(([rot, v, extra]) => `
      <div class="barra">
        <div class="rotulo"><span>${esc(rot)}</span><span>${brl.format(v)}${extra ? ' <small>' + extra + '</small>' : ''}</span></div>
        <div class="trilho"><div class="preenchido ${cls}" style="width:${max ? (Math.abs(v) / max * 100).toFixed(1) : 0}%"></div></div>
      </div>`).join('');
  }

  function cartao(rotulo, valor, cls = '', sub = '') {
    return `<div class="cartao"><span>${rotulo}</span><strong class="${cls}">${valor}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
  }

  function renderExtrato() {
    document.querySelectorAll('.filtros-extrato .datas').forEach(el => { el.hidden = document.getElementById('fPeriodo').value !== 'custom'; });
    const g = gruposContraparte();
    // Sugestões da busca: fornecedores/clientes ordenados por movimentação
    const sugest = Object.values(g.finais).sort((a, b) => b.n - a.n).slice(0, 400);
    const dl = document.getElementById('listaContrapartes');
    const htmlDl = sugest.map(f => `<option value="${esc(f.nome)}">`).join('');
    if (dl.innerHTML !== htmlDl) dl.innerHTML = htmlDl;

    const { lista, chaveBusca, busca, tipo } = filtrarExtrato();
    document.getElementById('fLimpar').hidden = !busca;
    const saidas = lista.filter(m => m.valor < 0), entradas = lista.filter(m => m.valor > 0);
    const totS = saidas.reduce((s, m) => s - m.valor, 0), totE = entradas.reduce((s, m) => s + m.valor, 0);
    const datas = lista.map(m => m.data).sort();
    const periodoTxt = datas.length ? `${dataBR(datas[0])} a ${dataBR(datas[datas.length - 1])}` : '';

    // Título e cartões de resumo
    const nomeBusca = chaveBusca ? Object.values(g.mapa).find(x => x.chave === chaveBusca).nome : busca;
    const selB = document.getElementById('fBanco');
    const bancoTxt = selB.value ? selB.options[selB.selectedIndex].text.replace(/ · \d+ conta\(s\)$/, '') : 'todos os bancos';
    document.getElementById('tituloResumo').innerHTML = (nomeBusca ? `Resumo: ${esc(nomeBusca)}` : 'Resumo do filtro') +
      ` <small>· ${esc(bancoTxt)}${periodoTxt ? ' · ' + periodoTxt : ''}</small>`;
    const principal = tipo === 'entrada' ? entradas : saidas;
    const totP = tipo === 'entrada' ? totE : totS;
    const maior = principal.reduce((m, x) => Math.abs(x.valor) > Math.abs(m ? m.valor : 0) ? x : m, null);
    const palavra = tipo === 'entrada' ? 'recebido' : 'pago';
    let cards;
    if (tipo === '') {
      cards = cartao('Total pago (saídas)', brl.format(totS), 'neg', `${saidas.length} pagamento(s)`) +
        cartao('Total recebido (entradas)', brl.format(totE), 'pos', `${entradas.length} recebimento(s)`) +
        cartao('Diferença', brl.format(totE - totS), totE - totS < 0 ? 'neg' : 'pos', 'entradas − saídas') +
        cartao('Movimentações', String(lista.length), '', periodoTxt);
    } else {
      cards = cartao(`Total ${palavra}`, brl.format(totP), tipo === 'entrada' ? 'pos' : 'neg', `${principal.length} ${tipo === 'entrada' ? 'recebimento(s)' : 'pagamento(s)'}`) +
        cartao('Valor médio', brl.format(principal.length ? totP / principal.length : 0)) +
        cartao(tipo === 'entrada' ? 'Maior recebimento' : 'Maior pagamento', maior ? brl.format(Math.abs(maior.valor)) : '—', '', maior ? dataBR(maior.data) : '') +
        cartao(tipo === 'entrada' ? 'Último recebimento' : 'Último pagamento', datas.length ? dataBR(datas[datas.length - 1]) : '—', '', datas.length ? `primeiro em ${dataBR(datas[0])}` : '');
    }
    document.getElementById('resumoCartoes').innerHTML = lista.length ? cards : '';

    // Ranking de fornecedores (ou clientes)
    const base = tipo === 'entrada' ? entradas : saidas;
    const rank = {};
    for (const m of base) {
      const f = fornecedorDe(m);
      const k = f.chave || f.nome;
      const r = rank[k] || (rank[k] = { nome: f.nome, total: 0, n: 0 });
      r.total += Math.abs(m.valor); r.n++;
    }
    const lr = Object.values(rank).sort((a, b) => b.total - a.total);
    document.getElementById('tituloRanking').textContent = tipo === 'entrada' ? 'De quem você mais recebeu' : 'Para quem você mais pagou';
    const totRank = lr.reduce((s, r) => s + r.total, 0);
    document.getElementById('ranking').innerHTML = lr.length ? lr.slice(0, limiteRanking).map(r => `
      <li data-fornecedor="${esc(r.nome)}" title="Ver só ${esc(r.nome)}">
        <div><span class="nome">${esc(r.nome)}</span><small>${r.n} ${r.n === 1 ? 'vez' : 'vezes'} · ${totRank ? (r.total / totRank * 100).toFixed(1).replace('.', ',') : 0}% do total</small></div>
        <span class="valor">${brl.format(r.total)}</span>
      </li>`).join('') : '<li class="vazio">Nada no filtro.</li>';
    const btnMais = document.getElementById('rankingMais');
    btnMais.hidden = lr.length <= limiteRanking;

    // Por banco e por mês
    const porConta = {};
    for (const m of lista) {
      const c = estado.contas.find(c => c.id === m.contaId);
      const rot = c ? c.nome : '—';
      porConta[rot] = (porConta[rot] || 0) + (tipo === '' ? m.valor : Math.abs(m.valor));
    }
    document.getElementById('porBanco').innerHTML = barras(Object.entries(porConta).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])));
    const porMes = {};
    for (const m of lista) { const k = m.data.slice(0, 7); porMes[k] = (porMes[k] || 0) + (tipo === '' ? m.valor : Math.abs(m.valor)); }
    const nomeMesCurto = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' });
    document.getElementById('porMes').innerHTML = barras(Object.entries(porMes).sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, v]) => { const [a, mm] = k.split('-').map(Number); return [nomeMesCurto.format(new Date(a, mm - 1, 1)).replace('.', ''), v]; }));

    // Tabela
    document.getElementById('contagem').textContent = lista.length
      ? `${lista.length} movimentação(ões)${lista.length > limiteTabela ? ` · mostrando as ${limiteTabela} mais recentes` : ''}` : '';
    document.getElementById('tabelaMais').hidden = lista.length <= limiteTabela;
    document.getElementById('tabelaExtrato').innerHTML = lista.length ? lista.slice(0, limiteTabela).map(m => {
      const f = fornecedorDe(m);
      return `<tr>
        <td>${dataBR(m.data)}</td>
        <td class="desc"><button type="button" class="link" data-fornecedor="${esc(f.nome)}" title="Ver só ${esc(f.nome)}">${esc(f.nome)}</button>
          ${m.lancId ? ' <small title="Conciliado com uma conta a pagar/receber">✔</small>' : ''}
          ${f.nome !== m.descricao ? `<span class="sub">${esc(m.descricao)}</span>` : ''}</td>
        <td><input class="cat-mov" data-mov="${m.id}" value="${esc(m.categoria)}" list="categorias" aria-label="Categoria"></td>
        <td>${esc(nomeConta(m.contaId))}</td>
        <td class="num ${m.valor > 0 ? 'pos' : 'neg'}">${brl.format(m.valor)}</td>
        <td><button class="mini perigo" data-excluir-mov="${m.id}">Excluir</button></td>
      </tr>`;
    }).join('')
      : `<tr><td colspan="6" class="vazio">${estado.movimentacoes.length ? 'Nenhuma movimentação com esses filtros.' : 'Nenhuma movimentação. Importe o extrato do seu banco na aba “Contas e saldos”.'}</td></tr>`;
  }

  // ---------- Imprimir (gera PDF pronto para imprimir) ----------
  const txt = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const lerCartoes = sel => [...document.querySelectorAll(sel + ' .cartao')].map(c =>
    [txt(c.querySelector('span')), txt(c.querySelector('strong')) + (txt(c.querySelector('small')) ? '  (' + txt(c.querySelector('small')) + ')' : '')]);
  const lerBarras = sel => [...document.querySelectorAll(sel + ' .barra .rotulo')].map(r => [...r.children].map(txt));
  const verTxt = () => { const s = document.getElementById('filtroEntidade'); return s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : 'Tudo'; };

  async function imprimir(rel, nomeArquivo, botao) {
    const rotulo = botao ? botao.textContent : '';
    if (botao) { botao.disabled = true; botao.textContent = 'Gerando PDF…'; }
    try {
      const blob = await window.Impressao.gerarPDF(rel);
      const dentroDoClaude = window.top !== window;
      if (!dentroDoClaude) {
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank'); // abre no leitor de PDF, que já pede para imprimir
        if (w) { setTimeout(() => URL.revokeObjectURL(url), 120000); return; }
      }
      await baixar(nomeArquivo, blob, 'application/pdf');
    } catch (e) {
      avisar((e && e.message) || 'Não foi possível gerar o PDF.');
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = rotulo; }
    }
  }

  function relatorioExtrato() {
    renderExtrato();
    const { lista, chaveBusca, busca, tipo } = filtrarExtrato();
    const selB = document.getElementById('fBanco'), selP = document.getElementById('fPeriodo'), selT = document.getElementById('fTipo');
    const bancoTxt = selB.value ? selB.options[selB.selectedIndex].text.replace(/ · \d+ conta\(s\)$/, '') : 'Todos os bancos';
    const datas = lista.map(m => m.data).sort();
    let periodo = selP.options[selP.selectedIndex].text;
    if (selP.value === 'custom') periodo = `${document.getElementById('fDe').value ? dataBR(document.getElementById('fDe').value) : 'início'} a ${document.getElementById('fAte').value ? dataBR(document.getElementById('fAte').value) : 'hoje'}`;
    const g = gruposContraparte();
    const nome = chaveBusca ? Object.values(g.mapa).find(x => x.chave === chaveBusca).nome : busca;
    const secoes = [{ titulo: 'Resumo', pares: lerCartoes('#resumoCartoes') }];
    const porBanco = lerBarras('#porBanco'), porMes = lerBarras('#porMes');
    if (porBanco.length > 1) secoes.push({ titulo: 'Por banco / conta', tabela: { cab: ['Banco / conta', 'Valor'], linhas: porBanco, direita: [1], colorir: false } });
    if (porMes.length > 1) secoes.push({ titulo: 'Por mês', tabela: { cab: ['Mês', 'Valor'], linhas: porMes, direita: [1], colorir: false } });
    if (!chaveBusca) {
      const itens = [...document.querySelectorAll('#ranking li[data-fornecedor]')];
      const base = tipo === 'entrada' ? lista.filter(m => m.valor > 0) : lista.filter(m => m.valor < 0);
      const rank = {};
      for (const m of base) { const f = fornecedorDe(m); const k = f.chave || f.nome; const r = rank[k] || (rank[k] = { nome: f.nome, total: 0, n: 0 }); r.total += Math.abs(m.valor); r.n++; }
      const lr = Object.values(rank).sort((a, b) => b.total - a.total).slice(0, 30);
      if (lr.length && itens.length) secoes.push({ titulo: tipo === 'entrada' ? 'De quem você mais recebeu' : 'Para quem você mais pagou (30 maiores)',
        tabela: { cab: ['#', 'Nome', 'Vezes', 'Total'], linhas: lr.map((r, i) => [String(i + 1), r.nome, String(r.n), brl.format(r.total)]), direita: [2, 3], larguras: { 0: 10 }, colorir: false } });
    }
    const total = lista.reduce((s, m) => s + m.valor, 0);
    secoes.push({ titulo: `Movimentações (${lista.length})`, tabela: {
      cab: ['Data', 'Fornecedor / cliente', 'Descrição no banco', 'Banco / conta', 'Categoria', 'Valor'],
      linhas: lista.map(m => { const f = fornecedorDe(m); return [dataBR(m.data), f.nome, f.nome === m.descricao ? '' : m.descricao, nomeConta(m.contaId), m.categoria || '', brl.format(m.valor)]; }),
      rodape: ['', '', '', '', 'Total', brl.format(total)],
      direita: [5], larguras: { 0: 20, 5: 28 }
    } });
    return {
      titulo: nome ? `Extrato: ${nome}` : 'Extrato',
      subtitulo: [
        `Movimento: ${selT.options[selT.selectedIndex].text}  |  Banco: ${bancoTxt}  |  Período: ${periodo}${datas.length ? ` (${dataBR(datas[0])} a ${dataBR(datas[datas.length - 1])})` : ''}`,
        `Titular: ${verTxt()}${busca && !chaveBusca ? `  |  Busca: "${busca}"` : ''}`
      ],
      secoes
    };
  }

  function relatorioPainel() {
    renderPainel();
    const secoes = [{ titulo: 'Resumo do mês', pares: lerCartoes('#painel .cartoes') }];
    const linhas = [];
    const visiveis = contasVisiveis();
    for (const e of estado.entidades) {
      const cs = visiveis.filter(c => c.entidadeId === e.id);
      if (!cs.length) continue;
      const tot = cs.reduce((s, c) => s + c.saldo, 0);
      const parte = e.tipo === 'sociedade' && Number.isFinite(e.participacao) ? ` - sua parte (${String(e.participacao).replace('.', ',')}%): ${brl.format(tot * e.participacao / 100)}` : '';
      linhas.push([`${e.nome}${e.tipo === 'pessoal' ? '' : ' (' + TIPOS_ENT[e.tipo] + ')'}${parte}`, '', brl.format(tot)]);
      cs.forEach(c => linhas.push(['', c.nome, brl.format(c.saldo)]));
    }
    if (linhas.length) secoes.push({ titulo: 'Saldo por titular e conta', tabela: { cab: ['Titular', 'Conta', 'Saldo'], linhas, direita: [2],
      rodape: ['', 'Total', brl.format(saldoTotal())] } });
    const cats = lerBarras('#graficoCategorias');
    if (cats.length) secoes.push({ titulo: 'Despesas do mês por categoria', tabela: { cab: ['Categoria', 'Valor'], linhas: cats, direita: [1], colorir: false } });
    const prox = lancVisiveis().filter(l => !l.pago).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    if (prox.length) secoes.push({ titulo: 'Contas pendentes', tabela: { cab: ['Vencimento', 'Descrição', 'Situação', 'Valor'],
      linhas: prox.map(l => [dataBR(l.vencimento), l.descricao, statusTexto(l), (l.tipo === 'receber' ? '' : '-') + brl.format(l.valor)]), direita: [3] } });
    return { titulo: 'Panorama Financeiro: ' + txt(document.getElementById('mesAtual')), subtitulo: [`Titular: ${verTxt()}`], secoes };
  }

  function relatorioLancamentos() {
    renderLancamentos();
    const sSt = document.getElementById('filtroStatus'), sTp = document.getElementById('filtroTipo');
    const linhas = [...document.querySelectorAll('#tabelaLanc tr')].filter(tr => tr.children.length > 1)
      .map(tr => [...tr.children].slice(0, 6).map(td => txt(td).replace(/🔁/g, '(mensal)')));
    return {
      titulo: 'Contas a pagar e a receber',
      subtitulo: [`Situação: ${sSt.options[sSt.selectedIndex].text}  |  Tipo: ${sTp.options[sTp.selectedIndex].text}  |  Titular: ${verTxt()}`],
      secoes: [{ titulo: `${linhas.length} lançamento(s)`, tabela: { cab: ['Vencimento', 'Descrição', 'Categoria', 'Conta', 'Valor', 'Situação'], linhas, direita: [4] } }]
    };
  }

  function filtrarFornecedor(nome) {
    document.getElementById('fBusca').value = nome;
    limiteTabela = 200;
    renderExtrato();
    document.getElementById('tituloResumo').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function exportarCSV() {
    const { lista } = filtrarExtrato();
    const linhas = [['Data', 'Fornecedor/Cliente', 'Descrição', 'Categoria', 'Banco/Conta', 'Titular', 'Valor']];
    for (const m of lista) {
      const c = estado.contas.find(c => c.id === m.contaId);
      linhas.push([dataBR(m.data), fornecedorDe(m).nome, m.descricao, m.categoria, c ? c.nome : '', c ? entidade(c.entidadeId).nome : '',
        m.valor.toFixed(2).replace('.', ',')]);
    }
    const csv = '﻿' + linhas.map(l => l.map(v => /[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(';')).join('\r\n');
    const nome = normNome(document.getElementById('fBusca').value).replace(/ /g, '-');
    baixar(`extrato${nome ? '-' + nome : ''}-${hoje()}.csv`, csv, 'text/csv;charset=utf-8');
  }

  // ---------- Formulários ----------
  const formLanc = document.getElementById('formLanc');
  formLanc.vencimento.value = hoje();

  formLanc.addEventListener('submit', e => {
    e.preventDefault();
    const f = formLanc;
    const dados = {
      tipo: f.tipo.value,
      descricao: f.descricao.value.trim(),
      valor: arred(Number(f.valor.value)),
      vencimento: f.vencimento.value,
      categoria: f.categoria.value.trim(),
      contaId: f.contaId.value,
      recorrente: f.recorrente.checked,
      diaOriginal: Number(f.vencimento.value.slice(8))
    };
    if (f.id.value) {
      const l = estado.lancamentos.find(x => x.id === f.id.value);
      if (l) {
        // Se já foi pago, ajusta o saldo para refletir valor/conta novos
        if (l.pago) {
          const antiga = estado.contas.find(c => c.id === l.contaId);
          if (antiga) antiga.saldo = arred(antiga.saldo - sinal(l) * l.valor);
          Object.assign(l, dados);
          const nova = estado.contas.find(c => c.id === l.contaId);
          if (nova) nova.saldo = arred(nova.saldo + sinal(l) * l.valor);
        } else {
          Object.assign(l, dados);
        }
      }
    } else {
      estado.lancamentos.push({ id: id(), pago: false, dataPagamento: null, proximaGerada: false, ...dados });
    }
    limparFormLanc();
    salvar();
  });

  function limparFormLanc() {
    const conta = formLanc.contaId.value;
    formLanc.reset();
    formLanc.id.value = '';
    formLanc.vencimento.value = hoje();
    formLanc.contaId.value = conta;
    document.getElementById('tituloFormLanc').textContent = 'Novo lançamento';
    document.getElementById('cancelarLanc').hidden = true;
  }
  document.getElementById('cancelarLanc').addEventListener('click', limparFormLanc);

  const formConta = document.getElementById('formConta');
  formConta.addEventListener('submit', e => {
    e.preventDefault();
    const f = formConta;
    const dados = { nome: f.nome.value.trim(), tipo: f.tipo.value, saldo: arred(Number(f.saldo.value)), entidadeId: f.entidadeId.value };
    if (f.id.value) {
      Object.assign(estado.contas.find(c => c.id === f.id.value) || {}, dados);
    } else {
      estado.contas.push({ id: id(), ...dados });
    }
    limparFormConta();
    salvar();
  });

  function limparFormConta() {
    const ent = formConta.entidadeId.value;
    formConta.reset();
    formConta.entidadeId.value = ent;
    formConta.id.value = '';
    document.getElementById('tituloFormConta').textContent = 'Nova conta';
    document.getElementById('cancelarConta').hidden = true;
  }
  document.getElementById('cancelarConta').addEventListener('click', limparFormConta);

  const formEnt = document.getElementById('formEnt');
  const atualizarCampoPct = () => { formEnt.querySelector('.so-sociedade').hidden = formEnt.tipo.value !== 'sociedade'; };
  formEnt.tipo.addEventListener('change', atualizarCampoPct);
  formEnt.addEventListener('submit', e => {
    e.preventDefault();
    const f = formEnt;
    const pct = Number(String(f.participacao.value).replace(',', '.'));
    const dados = {
      nome: f.nome.value.trim(),
      tipo: f.tipo.value,
      participacao: f.tipo.value === 'sociedade' && f.participacao.value !== '' && Number.isFinite(pct) ? pct : null,
      apelidos: f.apelidos.value.split(/\n|;/).map(s => s.trim()).filter(Boolean)
    };
    if (f.id.value) Object.assign(entidade(f.id.value), dados);
    else estado.entidades.push({ id: id(), ...dados });
    limparFormEnt();
    recategorizarInternas();
    salvar();
  });
  function limparFormEnt() {
    formEnt.reset();
    formEnt.id.value = '';
    document.getElementById('tituloFormEnt').textContent = 'Novo titular';
    document.getElementById('cancelarEnt').hidden = true;
    atualizarCampoPct();
  }
  document.getElementById('cancelarEnt').addEventListener('click', limparFormEnt);

  document.getElementById('filtroEntidade').addEventListener('change', e => {
    filtroEnt = e.target.value;
    try { localStorage.setItem(CHAVE + ':titular', filtroEnt); } catch (err) { /* sem armazenamento */ }
    document.getElementById('fBanco').value = '';
    render();
  });

  // ---------- Cliques (delegação) ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;

    if (d.aba) {
      document.querySelectorAll('.aba').forEach(x => x.classList.toggle('ativa', x === b));
      document.querySelectorAll('.secao').forEach(s => s.classList.toggle('ativa', s.id === d.aba));
      return;
    }
    if (d.pagar) {
      const l = estado.lancamentos.find(x => x.id === d.pagar);
      const conta = l && estado.contas.find(c => c.id === l.contaId);
      const msg = conta
        ? `Confirmar "${l.descricao}" (${brl.format(l.valor)})? O saldo de ${conta.nome} será atualizado.`
        : `Confirmar "${l.descricao}" (${brl.format(l.valor)})? Nenhuma conta vinculada — saldo não será alterado.`;
      if (await perguntar(msg)) marcarPago(d.pagar);
      return;
    }
    if (d.desfazer) { desfazerPago(d.desfazer); return; }
    if (d.fornecedor && b.classList.contains('link')) { filtrarFornecedor(d.fornecedor); return; }
    if (d.importar) {
      document.getElementById('contaImport').value = d.importar;
      document.getElementById('arquivoExtrato').click();
      return;
    }
    if (d.excluirMov) {
      const m = estado.movimentacoes.find(x => x.id === d.excluirMov);
      if (m && await perguntar(`Excluir a movimentação "${m.descricao}"? (O saldo da conta não será alterado.)`)) {
        if (m.lancId) {
          const l = estado.lancamentos.find(x => x.id === m.lancId);
          if (l) l.movId = null;
        }
        estado.movimentacoes = estado.movimentacoes.filter(x => x.id !== m.id);
        salvar();
      }
      return;
    }
    if (d.editarLanc) {
      const l = estado.lancamentos.find(x => x.id === d.editarLanc);
      if (!l) return;
      const f = formLanc;
      f.id.value = l.id; f.tipo.value = l.tipo; f.descricao.value = l.descricao; f.valor.value = l.valor;
      f.vencimento.value = l.vencimento; f.categoria.value = l.categoria || ''; f.contaId.value = l.contaId || '';
      f.recorrente.checked = !!l.recorrente;
      document.getElementById('tituloFormLanc').textContent = 'Editar lançamento';
      document.getElementById('cancelarLanc').hidden = false;
      f.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (d.excluirLanc) {
      const l = estado.lancamentos.find(x => x.id === d.excluirLanc);
      if (l && await perguntar(`Excluir "${l.descricao}"?${l.pago ? ' (O saldo da conta não será alterado.)' : ''}`)) {
        estado.lancamentos = estado.lancamentos.filter(x => x.id !== l.id);
        salvar();
      }
      return;
    }
    if (d.editarConta) {
      const c = estado.contas.find(x => x.id === d.editarConta);
      if (!c) return;
      formConta.id.value = c.id; formConta.nome.value = c.nome; formConta.tipo.value = c.tipo; formConta.saldo.value = c.saldo;
      formConta.entidadeId.value = c.entidadeId;
      document.getElementById('tituloFormConta').textContent = 'Editar conta';
      document.getElementById('cancelarConta').hidden = false;
      return;
    }
    if (d.editarEnt) {
      const en = entidade(d.editarEnt);
      formEnt.id.value = en.id; formEnt.nome.value = en.nome; formEnt.tipo.value = en.tipo;
      formEnt.participacao.value = en.participacao ?? ''; formEnt.apelidos.value = en.apelidos.join('\n');
      document.getElementById('tituloFormEnt').textContent = 'Editar titular';
      document.getElementById('cancelarEnt').hidden = false;
      atualizarCampoPct();
      formEnt.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (d.excluirEnt) {
      const en = entidade(d.excluirEnt);
      if (estado.contas.some(c => c.entidadeId === en.id)) { avisar(`"${en.nome}" ainda tem contas. Mude ou exclua as contas antes.`); return; }
      if (await perguntar(`Excluir o titular "${en.nome}"?`)) {
        estado.entidades = estado.entidades.filter(x => x.id !== en.id);
        if (filtroEnt === en.id) filtroEnt = '';
        salvar();
      }
      return;
    }
    if (d.excluirConta) {
      const c = estado.contas.find(x => x.id === d.excluirConta);
      if (c && await perguntar(`Excluir a conta "${c.nome}"? Os lançamentos vinculados ficarão sem conta e as movimentações importadas dela serão apagadas.`)) {
        estado.contas = estado.contas.filter(x => x.id !== c.id);
        estado.movimentacoes = estado.movimentacoes.filter(m => m.contaId !== c.id);
        estado.lancamentos.forEach(l => { if (l.contaId === c.id) l.contaId = ''; });
        salvar();
      }
    }
  });

  document.getElementById('mesAnterior').addEventListener('click', () => { mesVisto = somaMes(mesVisto, -1); renderPainel(); });
  document.getElementById('mesProximo').addEventListener('click', () => { mesVisto = somaMes(mesVisto, 1); renderPainel(); });
  document.getElementById('filtroStatus').addEventListener('change', renderLancamentos);
  document.getElementById('filtroTipo').addEventListener('change', renderLancamentos);

  // ---------- Dados ----------
  document.getElementById('exportar').addEventListener('click', () => {
    baixar(`panorama-financeiro-${hoje()}.json`, JSON.stringify(estado), 'application/json');
  });

  document.getElementById('importar').addEventListener('change', async e => {
    const arq = e.target.files[0];
    if (!arq) return;
    let dados = null;
    try { dados = valido(JSON.parse(await arq.text())); } catch (err) { dados = null; }
    e.target.value = '';
    if (!dados) { avisar('Este arquivo não é um backup do Panorama Financeiro.'); return; }
    const temDados = estado.movimentacoes.length || estado.contas.length || estado.lancamentos.length;
    if (temDados && !(await perguntar('Substituir todos os dados atuais pelos do backup?', { ok: 'Substituir' }))) return;
    estado = dados; filtroEnt = '';
    salvar();
    const st = document.getElementById('statusImport');
    st.hidden = false; st.className = 'status ok';
    st.innerHTML = `<strong>Backup carregado:</strong> ${dados.contas.length} conta(s) e ${dados.movimentacoes.length} movimentação(ões). ` +
      'Veja em <button type="button" class="link" data-aba-ir="painel">Painel</button> e <button type="button" class="link" data-aba-ir="extrato">Extrato</button>.';
  });

  document.getElementById('limpar').addEventListener('click', async () => {
    if (await perguntar('Apagar TODOS os dados? Isso não pode ser desfeito.', { ok: 'Apagar tudo' })) { estado = vazio(); filtroEnt = ''; salvar(); }
  });

  document.getElementById('exemplo').addEventListener('click', async () => {
    if ((estado.contas.length || estado.lancamentos.length) && !(await perguntar('Isso vai substituir seus dados atuais. Continuar?'))) return;
    const mes = hoje().slice(0, 7);
    const dia = n => `${mes}-${String(n).padStart(2, '0')}`;
    const c1 = id(), c2 = id(), c3 = id();
    const novo = (tipo, descricao, valor, d, categoria, contaId, recorrente = true) =>
      ({ id: id(), tipo, descricao, valor, vencimento: dia(d), categoria, contaId, recorrente, diaOriginal: d, pago: false, dataPagamento: null, proximaGerada: false });
    estado = {
      entidades: [entPessoal()],
      movimentacoes: [],
      contas: [
        { id: c1, nome: 'Banco principal', tipo: 'Conta corrente', saldo: 3200, entidadeId: 'pessoal' },
        { id: c2, nome: 'Poupança', tipo: 'Poupança', saldo: 8500, entidadeId: 'pessoal' },
        { id: c3, nome: 'Carteira', tipo: 'Dinheiro', saldo: 150, entidadeId: 'pessoal' }
      ],
      lancamentos: [
        novo('receber', 'Salário', 5500, 5, 'Salário', c1),
        novo('pagar', 'Aluguel', 1800, 10, 'Moradia', c1),
        novo('pagar', 'Energia', 210.5, 15, 'Contas da casa', c1),
        novo('pagar', 'Internet', 120, 20, 'Contas da casa', c1),
        novo('pagar', 'Cartão de crédito', 1350, 25, 'Cartão', c1),
        novo('pagar', 'Academia', 99.9, 7, 'Saúde', c1),
        novo('pagar', 'IPVA', 640, 28, 'Transporte', c1, false)
      ]
    };
    salvar();
  });

  // ---------- Extrato ----------
  const reExtrato = () => { limiteTabela = 200; limiteRanking = 10; renderExtrato(); };
  ['fBanco', 'fTipo', 'fPeriodo', 'fDe', 'fAte', 'fInternas'].forEach(idEl => document.getElementById(idEl).addEventListener('change', reExtrato));
  let tBusca = null;
  document.getElementById('fBusca').addEventListener('input', () => { clearTimeout(tBusca); tBusca = setTimeout(reExtrato, 200); });
  document.getElementById('fLimpar').addEventListener('click', () => { document.getElementById('fBusca').value = ''; reExtrato(); document.getElementById('fBusca').focus(); });
  document.getElementById('rankingMais').addEventListener('click', () => { limiteRanking += 20; renderExtrato(); });
  document.getElementById('tabelaMais').addEventListener('click', () => { limiteTabela += 300; renderExtrato(); });
  document.getElementById('exportarCSV').addEventListener('click', exportarCSV);
  const nomeArq = base => `${base}-${hoje()}.pdf`;
  document.getElementById('imprimirExtrato').addEventListener('click', e => {
    const nome = normNome(document.getElementById('fBusca').value).replace(/ /g, '-');
    imprimir(relatorioExtrato(), nomeArq('extrato' + (nome ? '-' + nome : '')), e.currentTarget);
  });
  document.getElementById('imprimirPainel').addEventListener('click', e => imprimir(relatorioPainel(), nomeArq('panorama-' + mesVisto), e.currentTarget));
  document.getElementById('imprimirLanc').addEventListener('click', e => imprimir(relatorioLancamentos(), nomeArq('contas-a-pagar'), e.currentTarget));
  document.getElementById('ranking').addEventListener('click', e => {
    const li = e.target.closest('li[data-fornecedor]');
    if (li) filtrarFornecedor(li.dataset.fornecedor);
  });
  document.getElementById('tabelaExtrato').addEventListener('change', async e => {
    const inp = e.target.closest('.cat-mov');
    if (!inp) return;
    const m = estado.movimentacoes.find(x => x.id === inp.dataset.mov);
    if (!m) return;
    const nova = inp.value.trim() || 'Outros';
    const iguais = estado.movimentacoes.filter(x => x.id !== m.id && x.descricao === m.descricao && x.categoria !== nova);
    m.categoria = nova;
    m.categoriaManual = true;
    if (iguais.length && await perguntar(`Aplicar a categoria "${nova}" também às outras ${iguais.length} movimentação(ões) "${m.descricao}"?`)) {
      iguais.forEach(x => { x.categoria = nova; x.categoriaManual = true; });
    }
    salvar();
  });

  // Importa um ou vários arquivos (PDF/OFX/CSV) em sequência, mostrando o andamento
  async function importarArquivos(arquivos, contaId, elMsg) {
    const status = document.getElementById('statusImport');
    const lista = [...arquivos];
    if (!lista.length) return;
    const linhas = [];
    const mostrar = (txt, cls) => {
      for (const el of [elMsg, status]) {
        if (!el) continue;
        el.hidden = false;
        el.className = (el === status ? 'status ' : 'msg ') + (cls || '');
        el.innerHTML = txt;
      }
    };
    let ok = 0;
    for (const [n, arq] of lista.entries()) {
      mostrar(`Lendo ${esc(arq.name)} (${n + 1} de ${lista.length})…` + (linhas.length ? '<br>' + linhas.join('<br>') : ''));
      try {
        linhas.push('✔ ' + esc(arq.name) + ': ' + esc(await importarExtrato(contaId, arq)));
        ok++;
      } catch (err) {
        linhas.push('✖ ' + esc(arq.name) + ': ' + esc(err.message || 'não foi possível ler o arquivo.'));
      }
    }
    mostrar(`<strong>Importação concluída: ${ok} de ${lista.length} arquivo(s).</strong><br>` + linhas.join('<br>') +
      (ok ? '<br>Veja em <button type="button" class="link" data-aba-ir="painel">Painel</button> e <button type="button" class="link" data-aba-ir="extrato">Extrato</button>.' : ''),
      ok === lista.length ? 'ok' : 'erro');
  }

  document.getElementById('arquivoExtrato').addEventListener('change', async e => {
    try { await importarArquivos(e.target.files, document.getElementById('contaImport').value, document.getElementById('msgImport')); }
    finally { e.target.value = ''; }
  });
  document.getElementById('arquivoRapido').addEventListener('change', async e => {
    try { await importarArquivos(e.target.files, '__auto', null); }
    finally { e.target.value = ''; }
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-abrir-import], [data-abrir-backup], [data-aba-ir], #fecharStatus');
    if (!b) return;
    if (b.id === 'fecharStatus') { document.getElementById('statusImport').hidden = true; return; }
    if (b.dataset.abrirImport !== undefined) document.getElementById('arquivoRapido').click();
    if (b.dataset.abrirBackup !== undefined) document.getElementById('importar').click();
    if (b.dataset.abaIr) document.querySelector(`.aba[data-aba="${b.dataset.abaIr}"]`).click();
  });

  render();
  mostrarStatusNuvem();
  conectarNuvem();
})();
