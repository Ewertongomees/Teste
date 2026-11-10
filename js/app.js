// Panorama Financeiro — tudo roda no navegador e fica salvo no localStorage.
(function () {
  'use strict';

  const CHAVE = 'panorama-financeiro-v1';
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const nomeMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

  // ---------- Estado ----------
  let estado = carregar();
  let mesVisto = hoje().slice(0, 7); // "AAAA-MM"

  function vazio() { return { contas: [], lancamentos: [] }; }

  function carregar() {
    try {
      const bruto = localStorage.getItem(CHAVE);
      if (bruto) {
        const dados = JSON.parse(bruto);
        if (Array.isArray(dados.contas) && Array.isArray(dados.lancamentos)) return dados;
      }
    } catch (e) { /* armazenamento indisponível ou corrompido */ }
    return vazio();
  }

  function salvar() {
    try { localStorage.setItem(CHAVE, JSON.stringify(estado)); } catch (e) {
      alert('Não foi possível salvar os dados neste navegador.');
    }
    render();
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
  function saldoTotal() { return estado.contas.reduce((s, c) => s + c.saldo, 0); }
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
    l.pago = true;
    l.dataPagamento = hoje();
    const conta = estado.contas.find(c => c.id === l.contaId);
    if (conta) conta.saldo = arred(conta.saldo + sinal(l) * l.valor);
    if (l.recorrente && !l.proximaGerada) {
      l.proximaGerada = true;
      estado.lancamentos.push({
        ...l, id: id(), vencimento: proximaData(l.vencimento, l.diaOriginal),
        pago: false, dataPagamento: null, proximaGerada: false
      });
    }
    salvar();
  }

  function desfazerPago(lancId) {
    const l = estado.lancamentos.find(x => x.id === lancId);
    if (!l || !l.pago) return;
    const conta = estado.contas.find(c => c.id === l.contaId);
    if (conta) conta.saldo = arred(conta.saldo - sinal(l) * l.valor);
    l.pago = false;
    l.dataPagamento = null;
    salvar();
  }

  function arred(v) { return Math.round(v * 100) / 100; }

  // ---------- Renderização ----------
  function render() {
    renderPainel();
    renderLancamentos();
    renderContas();
    renderSelects();
  }

  function renderPainel() {
    const inicio = `${mesVisto}-01`;
    const fim = fimDoMes(mesVisto);
    const hj = hoje();
    const [a, m] = mesVisto.split('-').map(Number);
    const rotulo = nomeMes.format(new Date(a, m - 1, 1));
    document.getElementById('mesAtual').textContent = rotulo.charAt(0).toUpperCase() + rotulo.slice(1);

    const ocorr = ocorrenciasAte(fim);
    const doMes = ocorr.filter(l => l.vencimento >= inicio && l.vencimento <= fim);
    const pendDoMes = doMes.filter(l => !l.pago);
    const somar = arr => arr.reduce((s, l) => s + l.valor, 0);

    const receber = somar(pendDoMes.filter(l => l.tipo === 'receber'));
    const pagar = somar(pendDoMes.filter(l => l.tipo === 'pagar'));
    // Previsto: saldo de hoje + tudo que ainda está pendente até o fim do mês visto (inclui atrasados)
    const pendAteFim = ocorr.filter(l => !l.pago && l.vencimento <= fim);
    const previsto = saldoTotal() + pendAteFim.reduce((s, l) => s + sinal(l) * l.valor, 0);

    setValor('kSaldo', saldoTotal());
    document.getElementById('kReceber').textContent = brl.format(receber);
    document.getElementById('kPagar').textContent = brl.format(pagar);
    setValor('kPrevisto', previsto);

    // Alerta de vencidas
    const vencidas = estado.lancamentos.filter(l => !l.pago && l.tipo === 'pagar' && l.vencimento < hj);
    const alerta = document.getElementById('alertaVencidas');
    if (vencidas.length) {
      alerta.hidden = false;
      alerta.innerHTML = `<strong>Atenção:</strong> ${vencidas.length} conta(s) vencida(s), totalizando ${brl.format(somar(vencidas))}.`;
    } else {
      alerta.hidden = true;
    }

    // Próximos vencimentos (pendentes reais, a partir de hoje e atrasados)
    const proximos = estado.lancamentos.filter(l => !l.pago)
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
    const cats = Object.entries(porCat).sort((x, y) => y[1] - x[1]);
    const max = cats.length ? cats[0][1] : 0;
    document.getElementById('graficoCategorias').innerHTML = cats.length ? cats.map(([c, v]) => `
      <div class="barra">
        <div class="rotulo"><span>${esc(c)}</span><span>${brl.format(v)}</span></div>
        <div class="trilho"><div class="preenchido" style="width:${(v / max * 100).toFixed(1)}%"></div></div>
      </div>`).join('') : '<p class="vazio">Sem despesas neste mês.</p>';

    // Saldo por conta
    const ulSaldos = document.getElementById('listaSaldos');
    ulSaldos.innerHTML = estado.contas.length ? estado.contas.map(c => `
      <li><div>${esc(c.nome)}<small>${esc(c.tipo)}</small></div>
      <span class="valor ${c.saldo < 0 ? 'neg' : ''}">${brl.format(c.saldo)}</span></li>`).join('')
      : '<li class="vazio">Cadastre suas contas na aba “Contas e saldos”.</li>';
  }

  function setValor(elId, v) {
    const el = document.getElementById(elId);
    el.textContent = brl.format(v);
    el.className = v < 0 ? 'neg' : '';
  }

  function statusTexto(l) {
    if (l.pago) return l.tipo === 'receber' ? 'Recebido' : 'Pago';
    if (l.vencimento < hoje()) return 'Vencida';
    if (l.vencimento === hoje()) return 'Vence hoje';
    return 'Pendente';
  }

  function renderLancamentos() {
    const status = document.getElementById('filtroStatus').value;
    const tipo = document.getElementById('filtroTipo').value;
    const hj = hoje();
    let lista = estado.lancamentos.filter(l => !tipo || l.tipo === tipo);
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
    ul.innerHTML = estado.contas.length ? estado.contas.map(c => `
      <li>
        <div><strong>${esc(c.nome)}</strong><small>${esc(c.tipo)}</small></div>
        <div class="acoes">
          <span class="valor ${c.saldo < 0 ? 'neg' : ''}">${brl.format(c.saldo)}</span>
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

    const cats = [...new Set(estado.lancamentos.map(l => l.categoria).filter(Boolean))].sort();
    document.getElementById('categorias').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
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
    const dados = { nome: f.nome.value.trim(), tipo: f.tipo.value, saldo: arred(Number(f.saldo.value)) };
    if (f.id.value) {
      Object.assign(estado.contas.find(c => c.id === f.id.value) || {}, dados);
    } else {
      estado.contas.push({ id: id(), ...dados });
    }
    limparFormConta();
    salvar();
  });

  function limparFormConta() {
    formConta.reset();
    formConta.id.value = '';
    document.getElementById('tituloFormConta').textContent = 'Nova conta';
    document.getElementById('cancelarConta').hidden = true;
  }
  document.getElementById('cancelarConta').addEventListener('click', limparFormConta);

  // ---------- Cliques (delegação) ----------
  document.addEventListener('click', e => {
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
      if (confirm(msg)) marcarPago(d.pagar);
      return;
    }
    if (d.desfazer) { desfazerPago(d.desfazer); return; }
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
      if (l && confirm(`Excluir "${l.descricao}"?${l.pago ? ' (O saldo da conta não será alterado.)' : ''}`)) {
        estado.lancamentos = estado.lancamentos.filter(x => x.id !== l.id);
        salvar();
      }
      return;
    }
    if (d.editarConta) {
      const c = estado.contas.find(x => x.id === d.editarConta);
      if (!c) return;
      formConta.id.value = c.id; formConta.nome.value = c.nome; formConta.tipo.value = c.tipo; formConta.saldo.value = c.saldo;
      document.getElementById('tituloFormConta').textContent = 'Editar conta';
      document.getElementById('cancelarConta').hidden = false;
      return;
    }
    if (d.excluirConta) {
      const c = estado.contas.find(x => x.id === d.excluirConta);
      if (c && confirm(`Excluir a conta "${c.nome}"? Os lançamentos vinculados ficarão sem conta.`)) {
        estado.contas = estado.contas.filter(x => x.id !== c.id);
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
    const blob = new Blob([JSON.stringify(estado, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `panorama-financeiro-${hoje()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('importar').addEventListener('change', e => {
    const arq = e.target.files[0];
    if (!arq) return;
    arq.text().then(txt => {
      const dados = JSON.parse(txt);
      if (!Array.isArray(dados.contas) || !Array.isArray(dados.lancamentos)) throw new Error('formato');
      if (confirm('Substituir todos os dados atuais pelos do arquivo?')) { estado = dados; salvar(); }
    }).catch(() => alert('Arquivo inválido.')).finally(() => { e.target.value = ''; });
  });

  document.getElementById('limpar').addEventListener('click', () => {
    if (confirm('Apagar TODOS os dados? Isso não pode ser desfeito.')) { estado = vazio(); salvar(); }
  });

  document.getElementById('exemplo').addEventListener('click', () => {
    if ((estado.contas.length || estado.lancamentos.length) && !confirm('Isso vai substituir seus dados atuais. Continuar?')) return;
    const mes = hoje().slice(0, 7);
    const dia = n => `${mes}-${String(n).padStart(2, '0')}`;
    const c1 = id(), c2 = id(), c3 = id();
    const novo = (tipo, descricao, valor, d, categoria, contaId, recorrente = true) =>
      ({ id: id(), tipo, descricao, valor, vencimento: dia(d), categoria, contaId, recorrente, diaOriginal: d, pago: false, dataPagamento: null, proximaGerada: false });
    estado = {
      contas: [
        { id: c1, nome: 'Banco principal', tipo: 'Conta corrente', saldo: 3200 },
        { id: c2, nome: 'Poupança', tipo: 'Poupança', saldo: 8500 },
        { id: c3, nome: 'Carteira', tipo: 'Dinheiro', saldo: 150 }
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

  render();
})();
