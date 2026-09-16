# Como baixar e usar o Pi

**Pi** é um agente de código minimalista que roda no terminal. Você conversa com ele e ele lê, escreve, edita arquivos e executa comandos para cumprir seus pedidos. É extensível via **extensões TypeScript**, **skills**, **templates de prompt** e **temas** (agrupados como *packages* npm/git).

Site oficial: <https://pi.dev> · Docs: <https://pi.dev/docs> · Código: <https://github.com/badlogic/pi-mono>

---

## 1. Requisitos

| Item | Observação |
|---|---|
| Node.js 20+ | `node --version` para verificar |
| Bash | No Windows: instalar o [Git for Windows](https://git-scm.com/download/win) (traz o Git Bash) |
| Chave de API ou assinatura | Anthropic, OpenAI, Google, OpenRouter, Ollama etc. |

## 2. Baixar e instalar

Escolha **uma** das opções:

**Windows (PowerShell):**
```powershell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

**Linux/macOS:**
```bash
curl -fsSL https://pi.dev/install.sh | sh
```

**Via npm (qualquer sistema):**
```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

**Binário pronto:** baixe de <https://github.com/badlogic/pi-mono/releases> (ex.: `pi-windows-x64.zip` → descompacte e rode `pi.exe`).

Verificar a instalação:
```bash
pi --version
```

## 3. Primeiro uso

```bash
cd seu-projeto
pi
```

Na primeira execução, autentique com `/login` (escolha o provedor) ou exporte uma chave antes de abrir:
```bash
export ANTHROPIC_API_KEY=sk-ant-...        # Linux/macOS
setx ANTHROPIC_API_KEY "sk-ant-..."        # Windows (persiste)
```

Escolha o modelo com `/model` (ou `Ctrl+L`) — dá para trocar no meio da sessão.

## 4. Uso básico

Converse normalmente ("crie um servidor Express em src/server.ts") — o Pi usa as ferramentas `read`, `write`, `edit` e `bash`.

Comandos úteis:

| Comando | O que faz |
|---|---|
| `pi` | abre o modo interativo |
| `pi -c` / `--continue` | continua a sessão mais recente |
| `pi -r` / `--resume` | escolhe uma sessão anterior |
| `pi -p "pergunta"` | modo print (resposta única, para scripts) |
| `pi --tools read,bash` | habilita só ferramentas específicas |
| `/tree` | navega/ramifica a árvore da sessão |
| `/model` | troca de modelo/provedor |
| `/export`, `/share` | exporta a sessão em HTML / gist |

Arquivos de contexto: o Pi carrega `AGENTS.md` (ou `CLAUDE.md`) de `~/.pi/agent/`, das pastas pai e da pasta atual — use para instruções do projeto.

Sessões ficam em `~/.pi/agent/sessions/`.

## 5. Extensões e packages

```bash
pi install npm:@foo/pi-tools        # de um package npm
pi install git:github.com/user/repo # de um repositório git
pi list                             # lista o que está instalado
pi update                           # atualiza tudo
```

## 6. Este repositório (github.com/danilo-paiva/pi)

Este repo guarda a configuração personalizada do Pi. Para usá-lo:

1. Clone: `git clone https://github.com/danilo-paiva/pi.git`
2. Copie o conteúdo para `~/.pi/agent/` (no Windows: `C:\Users\<voce>\.pi\agent\`):
   - `settings.json` — modelo padrão, thinking level, pacotes instalados, tema
   - `themes/` — temas (`github-dark-default`, `opencode`, `vibrant`)
   - `skills/` — skills do agente
   - extensões: `ask-user`, `background-terminals`, `browser-tool`, `subagents-orchestrator`, `ui-customization`
3. Instale os packages listados em `settings.json` (o Pi resolve isso com `pi update` ou individualmente):
   ```bash
   pi install npm:@narumitw/pi-goal
   pi install npm:pi-web-access
   pi install npm:pi-paster
   pi install npm:pi-tps-meter
   pi install npm:pi-mcp-adapter
   ```
4. A pasta `esp32-drone-kit/` é material à parte (kit de drone ESP32), não faz parte da config do agente.

Configuração principal em `settings.json`: modelo padrão `mimo-v2.5-free` (provedor `opencode`), thinking `high`, tema `github-dark-default`.

## 7. Atualizar / desinstalar

```bash
npm update -g @earendil-works/pi-coding-agent   # via npm
# ou reinstale com o script de instalação (passo 2)
npm uninstall -g @earendil-works/pi-coding-agent # desinstalar
```
