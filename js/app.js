// Panorama Financeiro — tudo roda no navegador e fica salvo no localStorage.
(function () {
  'use strict';

  const CHAVE = 'panorama-financeiro-v1';
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const nomeMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

  // ---------- Estado ----------
  let estado = carregar();
  let mesVisto = hoje().slice(0, 7); // "AAAA-MM"

  function vazio() { return { contas: [], lancamentos: [], movimentacoes: [] }; }

  function valido(dados) {
    if (!dados || !Array.isArray(dados.contas) || !Array.isArray(dados.lancamentos)) return null;
    if (!Array.isArray(dados.movimentacoes)) dados.movimentacoes = [];
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

  async function importarExtrato(contaId, arquivo) {
    const conta = estado.contas.find(c => c.id === contaId);
    if (!conta) throw new Error('Escolha a conta do banco antes de importar.');
    const r = await window.Extrato.ler(arquivo);

    const chave = t => t.fitid ? 'f:' + t.fitid : `d:${t.data}|${t.valor}|${t.descricao}`;
    const existentes = new Set(estado.movimentacoes.filter(m => m.contaId === contaId).map(chave));
    const novas = [];
    for (const t of r.transacoes) {
      const k = chave(t);
      if (existentes.has(k)) continue;
      existentes.add(k);
      novas.push({ id: id(), contaId, ...t, categoria: window.Extrato.categorizar(t.descricao), lancId: null });
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
    if (r.saldo !== null) {
      if (Math.abs(r.saldo - conta.saldo) >= 0.01 &&
          confirm(`O banco informou saldo de ${brl.format(r.saldo)}${r.dataSaldo ? ' em ' + dataBR(r.dataSaldo) : ''}.\n` +
                  `O saldo cadastrado de "${conta.nome}" é ${brl.format(conta.saldo)}.\n\nAtualizar para o saldo do banco?`)) {
        conta.saldo = r.saldo;
        msgSaldo = ` Saldo atualizado para ${brl.format(r.saldo)}.`;
      }
    } else if (novas.length) {
      const total = arred(novas.reduce((s, m) => s + m.valor, 0));
      if (confirm(`${novas.length === 1 ? "A movimentação nova soma" : `As ${novas.length} movimentações novas somam`} ${brl.format(total)}.\n\n` +
                  `Aplicar esse valor ao saldo de "${conta.nome}" (${brl.format(conta.saldo)} → ${brl.format(arred(conta.saldo + total))})?\n\n` +
                  'Responda "Cancelar" se o saldo cadastrado já considera essas movimentações.')) {
        conta.saldo = arred(conta.saldo + total);
        msgSaldo = ` Saldo atualizado para ${brl.format(conta.saldo)}.`;
      }
    }
    conta.ultimaImportacao = hoje();
    salvar();

    const ignoradas = r.transacoes.length - novas.length;
    return `${r.formato}: ${novas.length} movimentação(ões) importada(s)` +
      (ignoradas ? `, ${ignoradas} já existia(m)` : '') +
      (conciliadas ? `, ${conciliadas} conta(s) a pagar/receber baixada(s) automaticamente` : '') + '.' + msgSaldo;
  }

  function arred(v) { return Math.round(v * 100) / 100; }

  // ---------- Renderização ----------
  function render() {
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
    // + gastos vindos do extrato do banco (os já conciliados com uma conta a pagar não contam de novo)
    for (const m of estado.movimentacoes) {
      if (m.valor >= 0 || m.lancId || m.data < inicio || m.data > fim) continue;
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

    // Saldo por conta
    const ulSaldos = document.getElementById('listaSaldos');
    ulSaldos.innerHTML = estado.contas.length ? estado.contas.map(c => `
      <li><div>${esc(c.nome)}<small>${esc(c.tipo)}${c.ultimaImportacao ? ' · extrato de ' + dataBR(c.ultimaImportacao) : ''}</small></div>
      <span class="valor ${c.saldo < 0 ? 'neg' : ''}">${brl.format(c.saldo)}</span></li>`).join('')
      : '<li class="vazio">Cadastre suas contas na aba “Contas e saldos”.</li>';
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
        <div><strong>${esc(c.nome)}</strong><small>${esc(c.tipo)}${c.ultimaImportacao ? ' · último extrato importado em ' + dataBR(c.ultimaImportacao) : ''}</small></div>
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

    for (const [selId, primeira] of [['contaImport', ''], ['filtroExtratoConta', '<option value="">Todas as contas</option>']]) {
      const s = document.getElementById(selId);
      const v = s.value;
      s.innerHTML = primeira + estado.contas.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
      if ([...s.options].some(o => o.value === v)) s.value = v;
    }
  }

  function renderExtrato() {
    const contaId = document.getElementById('filtroExtratoConta').value;
    const mes = document.getElementById('filtroExtratoMes').value;
    const lista = estado.movimentacoes
      .filter(m => (!contaId || m.contaId === contaId) && (!mes || m.data.startsWith(mes)))
      .sort((a, b) => b.data.localeCompare(a.data));
    const entradas = lista.filter(m => m.valor > 0).reduce((s, m) => s + m.valor, 0);
    const saidas = lista.filter(m => m.valor < 0).reduce((s, m) => s - m.valor, 0);
    document.getElementById('resumoExtrato').innerHTML = lista.length
      ? `Entradas <strong class="pos">${brl.format(entradas)}</strong> · Saídas <strong class="neg">${brl.format(saidas)}</strong> · ${lista.length} movimentação(ões)`
      : '';
    document.getElementById('tabelaExtrato').innerHTML = lista.length ? lista.map(m => `<tr>
        <td>${dataBR(m.data)}</td>
        <td>${esc(m.descricao)}${m.lancId ? ' <small title="Conciliado com uma conta a pagar/receber">✔</small>' : ''}</td>
        <td><input class="cat-mov" data-mov="${m.id}" value="${esc(m.categoria)}" list="categorias" aria-label="Categoria"></td>
        <td>${esc(nomeConta(m.contaId))}</td>
        <td class="num ${m.valor > 0 ? 'pos' : 'neg'}">${brl.format(m.valor)}</td>
        <td><button class="mini perigo" data-excluir-mov="${m.id}">Excluir</button></td>
      </tr>`).join('')
      : '<tr><td colspan="6" class="vazio">Nenhuma movimentação. Importe o extrato do seu banco na aba “Contas e saldos”.</td></tr>';
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
    if (d.importar) {
      document.getElementById('contaImport').value = d.importar;
      document.getElementById('arquivoExtrato').click();
      return;
    }
    if (d.excluirMov) {
      const m = estado.movimentacoes.find(x => x.id === d.excluirMov);
      if (m && confirm(`Excluir a movimentação "${m.descricao}"? (O saldo da conta não será alterado.)`)) {
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
      if (c && confirm(`Excluir a conta "${c.nome}"? Os lançamentos vinculados ficarão sem conta e as movimentações importadas dela serão apagadas.`)) {
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
      const dados = valido(JSON.parse(txt));
      if (!dados) throw new Error('formato');
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
      movimentacoes: [],
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

  // ---------- Extrato ----------
  document.getElementById('filtroExtratoMes').value = hoje().slice(0, 7);
  document.getElementById('filtroExtratoConta').addEventListener('change', renderExtrato);
  document.getElementById('filtroExtratoMes').addEventListener('change', renderExtrato);
  document.getElementById('tabelaExtrato').addEventListener('change', e => {
    const inp = e.target.closest('.cat-mov');
    if (!inp) return;
    const m = estado.movimentacoes.find(x => x.id === inp.dataset.mov);
    if (!m) return;
    const nova = inp.value.trim() || 'Outros';
    const iguais = estado.movimentacoes.filter(x => x.id !== m.id && x.descricao === m.descricao && x.categoria !== nova);
    m.categoria = nova;
    if (iguais.length && confirm(`Aplicar a categoria "${nova}" também às outras ${iguais.length} movimentação(ões) "${m.descricao}"?`)) {
      iguais.forEach(x => { x.categoria = nova; });
    }
    salvar();
  });

  document.getElementById('arquivoExtrato').addEventListener('change', async e => {
    const arq = e.target.files[0];
    const msg = document.getElementById('msgImport');
    if (!arq) return;
    msg.className = 'msg';
    msg.textContent = 'Lendo extrato…';
    try {
      msg.textContent = await importarExtrato(document.getElementById('contaImport').value, arq);
      msg.className = 'msg ok';
    } catch (err) {
      msg.textContent = err.message || 'Não foi possível ler o arquivo.';
      msg.className = 'msg erro';
    } finally {
      e.target.value = '';
    }
  });

  render();
})();
