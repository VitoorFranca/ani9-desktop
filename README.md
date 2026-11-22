# ANI-9 para macOS

O [ANI-9](https://www.ani9.online) numa janela própria no Mac. A interface é a
mesma do site e se atualiza junto com ele; o app acrescenta o que uma aba do
navegador não faz:

- **Avisos com a janela fechada.** Os lembretes da Rotina e os avisos do Foco
  chegam na hora enquanto o app estiver aberto, mesmo sem janela, com
  **Abrir** e **Feita**. Quando o macOS não aceita a notificação do app (ele
  recusa apps sem assinatura da Apple em alguns casos), o aviso aparece num
  painel do próprio app, no canto da tela.
- **Revisões no Dock**: o número de cartões esperando hoje.
- **Menus do macOS** em português: copiar e colar, recarregar, zoom,
  ⌘1–⌘8 para as áreas principais, ⌘, para Configurações.
- **Links para fora** (fontes dos roadmaps, links nos cartões) abrem no
  navegador padrão.
- **Aviso de versão nova** uma vez por dia (o app não se atualiza sozinho).
- **Assistente** (nas contas em que ele está ligado): o assistente e tutor do
  ANI-9 usa o [Claude Code](https://claude.com/claude-code) instalado no seu
  Mac, com o seu login. Ele pode ter mais de uma conversa ao mesmo tempo (a
  do assistente, chamado de qualquer tela, e a do Chat). Sem o Claude Code, o
  resto do app funciona igual.

Os seus dados continuam onde sempre estiveram, na nuvem do ANI-9: o mesmo
login, os mesmos baralhos no site e no celular. O app precisa de internet.

## Instalar

Requer macOS 26 num Mac com Apple Silicon.

1. Baixe `ANI-9-<versão>-macos-arm64.dmg` na
   [página de versões](https://github.com/VitoorFranca/ani9-desktop/releases/latest).
2. Abra o `.dmg` e arraste **ANI-9** para **Aplicativos**.
3. **Primeira abertura.** O app ainda não tem assinatura da Apple, então o
   macOS bloqueia na primeira vez. Abra o ANI-9, feche o aviso, vá em
   **Ajustes do Sistema → Privacidade e Segurança**, role até o fim e clique
   em **Abrir Mesmo Assim** ao lado de "ANI-9". (Desde o macOS 15, o botão
   direito → Abrir não basta.) Pelo Terminal, o mesmo efeito:
   `xattr -dr com.apple.quarantine /Applications/ANI-9.app`.
4. Entre com a sua conta do ANI-9.

Confira o arquivo baixado, se quiser: `shasum -a 256 -c ANI-9-<versão>-macos-arm64.dmg.sha256`.

**Lembretes com o app aberto:** fechar a janela (⌘W) só a esconde; o app
continua no Dock e os lembretes chegam. **⌘Q** encerra o app e, com ele, os
lembretes no Mac (no celular, eles continuam pelo site). Para ele abrir
sozinho, marque **ANI-9 → Abrir ao iniciar sessão**.

## Atualizar

O app avisa quando sai uma versão nova (e em **ANI-9 → Procurar
atualizações…**). Baixe o `.dmg` novo e arraste para Aplicativos,
substituindo o antigo. Como o app não tem assinatura da Apple, o macOS pode
pedir de novo a permissão de notificações depois de atualizar.

A maior parte das novidades nem precisa disso: a interface vem do site.

## Desinstalar

Apague `/Applications/ANI-9.app` e, se quiser apagar também a sessão e o
cache, `~/Library/Application Support/ANI-9`. Nenhum dado do ANI-9 fica só no
Mac.

## Desenvolver

```bash
pnpm install
pnpm test            # regras de navegação, ponte, versões, janela, menu
pnpm check           # TypeScript
pnpm start           # abre o app contra https://www.ani9.online
ANI9_DESKTOP_URL=http://127.0.0.1:4320 pnpm start   # contra o app web local
pnpm package         # release/ANI-9-<versão>-macos-arm64.dmg (assinatura ad-hoc)
```

`ANI9_DESKTOP_URL` aceita https, ou http só neste computador.

### Como funciona

```
src/main/        processo principal: janela, menus, avisos, Dock, versões, motor do Assistente
src/preload/     index.ts expõe window.ani9Desktop à página; aviso.ts, ao painel
src/shared/      o contrato da ponte (canais, tipos e validação com zod)
static/          painel de avisos e tela "sem conexão"
build/macos/     ícone e entitlements
```

A janela abre o site do ANI-9. A página fala com o app só pela ponte
`window.ani9Desktop`:

| Função                                         | O que faz                                               |
| ---------------------------------------------- | ------------------------------------------------------- |
| `bridge`, `version`                            | versão do contrato (1) e do app                         |
| `notify({ tag, title, body?, url?, taskId? })` | aviso; com `taskId`, oferece "Feita"                    |
| `setBadge(n)`                                  | número no Dock (0 apaga)                                |
| `onNavigate(fn)`                               | o menu ou um aviso pede para abrir uma tela (`/rotina`) |
| `onTaskDone(fn)`                               | "Feita" num aviso                                       |

| `assistant.status()` | o Claude Code deste Mac: pronto, ausente ou sem login |
| `assistant.channels` | `true` a partir da 0.3.0: várias conversas ao mesmo tempo, cada uma num canal |
| `assistant.start({ systemPrompt, token, model, channel? })` | abre a conversa do canal (até três; a mais parada cede a vez) |
| `assistant.send(texto, canal?)`, `interrupt(canal?)`, `stop(canal?)` | fala, para a resposta, encerra (sem canal, `stop` encerra todas) |
| `assistant.onEvent(fn)` | texto aos poucos, ferramenta chamada e respondida, fim do turno, uso; cada evento diz o canal |

Um motor sem uso por vinte minutos é encerrado; a página o inicia de novo
quando a conversa continua. Enquanto uma resposta está em andamento, o app
impede que o Mac entre em repouso (uma resposta longa falharia no meio).

O contrato muda só com versão nova de `bridge`, e o site confere cada função
antes de usar. Assim, um site novo continua funcionando com um app antigo.

### Segurança

- Janela com `contextIsolation`, `sandbox` e sem Node; o preload só repassa
  mensagens.
- O processo principal só aceita mensagens da página do ANI-9 (origem e frame
  principal conferidos) e valida cada uma com zod.
- Só o próprio site abre na janela; links `http(s)` e `mailto` vão para o
  navegador; o resto é bloqueado. Nada pode embutir `<webview>`.
- A página não recebe permissões além de copiar para a área de transferência
  e tela cheia.
- O Assistente roda o `claude` que você instalou, sem modificação, com um
  perfil fixo: nenhuma ferramenta do Claude Code (sem terminal, arquivos ou
  web), só as ferramentas do ANI-9 no endereço do próprio site, sem as suas
  configurações, skills, memória ou conectores, e sem guardar a conversa em
  disco. A página só escolhe o texto do tutor, o token da conversa, o modelo e
  o nome do canal (que só escolhe entre os motores do próprio app). Da chamada
  de uma ferramenta, a página fica sabendo o nome e se respondeu, nunca o que
  ela levou ou trouxe. O app nunca vê a credencial do Claude, e encerra a
  conversa se o motor abrir com qualquer ferramenta que não seja do ANI-9.
- Fuses do Electron: o binário não roda como Node, ignora `NODE_OPTIONS` e
  `--inspect` e só carrega o app de dentro do `app.asar`.

### Versões

1. Mude `version` no `package.json` e faça o commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.

O workflow [`release.yml`](.github/workflows/release.yml) testa, empacota e
publica a release com o `.dmg` e o SHA-256. Com os segredos de uma conta
Apple Developer (veja o workflow), o app sai assinado e notarizado.

## Licença

[MIT](LICENSE).
