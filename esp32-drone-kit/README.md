# ESP32 Mini Drone Kit — materiais (fontes oficiais)

Materiais de apoio do kit de mini drone ESP32 (Baidu NetDisk:
`https://pan.baidu.com/s/1jTYDlMDsGb-CXfWWQ1Osvg?pwd=8889`).
Como a Baidu NetDisk exige login para download via web/API, estes itens
foram baixados das **fontes oficiais** correspondentes.

## Conteúdo

| Pasta | Arquivo | Fonte oficial |
|---|---|---|
| `CH340-driver/` | `CH341SER.EXE` | WCH (Nanjing Qinheng) — <https://www.wch-ic.com/downloads/CH341SER_EXE.html> (espelho oficial: <https://github.com/WCH-IC/download/releases/tag/CH341>) |
| `flash-download-tool/` | `flash_download_tool.zip` (v3.9.11) | Espressif — <https://dl.espressif.com/public/flash_download_tool.zip> (guia: <https://docs.espressif.com/projects/esp-test-tools/en/latest/esp32/production_stage/tools/flash_download_tool.html>) |
| `source-code/CF-Drone-main/` | código-fonte da base open-source | GitHub — <https://github.com/songge8/CF-Drone> |

## Notas

- O código do kit no Baidu ("XW-Drone-main") é um fork do projeto open-source
  **CF-Drone** (songge8, adaptado para a placa do kit "琛光E1"; esquemático do kit:
  `SCH_XW_Z1_V2.0.pdf`). A estrutura de arquivos do XW-Drone é idêntica à do CF-Drone
  (renomeando `CF-Drone.ino` → `XW-Drone.ino`).
- O firmware binário pronto do kit (`XW-Drone.ino.merged.bin`) e os arquivos
  exclusivos do kit **não existem em fonte oficial** e ficam disponíveis apenas no
  link do Baidu (requer conta):

  - 参考教程/ — PDF de montagem e vídeos-tutorial (chinês/inglês) — *vídeos não incluídos*
  - 固件/XW-Drone.ino.merged.bin — firmware compilado
  - 原理图/SCH_XW_Z1_V2.0.pdf — esquemático da placa
  - 无人机保护罩.stl — capa de proteção para impressão 3D
  - 教程视频在参考教程文件夹中.txt — aviso sobre os vídeos

- Para gravar o firmware: use o `flash_download_tool` (modo ESP32, 4 MB), o binário
  `merged` inclui bootloader + partições + aplicativo.
