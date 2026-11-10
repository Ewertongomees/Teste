# Panorama Financeiro

Aplicativo web simples para ter um panorama geral da vida financeira: contas bancárias e saldos, contas a pagar e a receber, e previsão de saldo.

## Como usar

Abra o arquivo `index.html` no navegador. Não precisa instalar nada nem ter servidor.

Os dados ficam salvos no próprio navegador (localStorage). Use a aba **Dados** para exportar/importar um backup em JSON.

## Funcionalidades

- **Painel**: saldo atual, total a receber e a pagar no mês, saldo previsto no fim do mês, alerta de contas vencidas, próximos vencimentos, despesas por categoria e saldo por conta. Dá para navegar entre os meses para ver a previsão futura.
- **Contas a pagar / receber**: cadastro com descrição, valor, vencimento, categoria, conta vinculada e opção de repetir todo mês. Ao marcar como "Paguei"/"Recebi", o saldo da conta é atualizado e, se for recorrente, a próxima ocorrência é criada automaticamente.
- **Contas e saldos**: cadastro de contas (corrente, poupança, investimento, dinheiro…) com o saldo atual.
- **Conectar banco (importar extrato)**: envie o extrato exportado pelo banco em **OFX** ou **CSV** (Nubank, Itaú, Bradesco, BB, Caixa, Santander, Inter, C6…). O app importa as movimentações sem duplicar, categoriza os gastos automaticamente, atualiza o saldo (no OFX usa o saldo informado pelo banco) e dá baixa nas contas a pagar/receber que aparecem no extrato. O arquivo é lido apenas no navegador.
- **Extrato**: movimentações importadas por conta e mês, com entradas, saídas e categoria editável.
- **Dados**: exportar, importar, carregar dados de exemplo e apagar tudo.

## Estrutura

```
index.html      # páginas e formulários
css/style.css   # visual (tema claro/escuro automático)
js/app.js       # lógica do app
js/extrato.js   # leitura de extratos OFX/CSV e categorização automática
```
