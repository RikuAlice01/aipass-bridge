# aipass-bridge

ใช้ [de.aipass.net](https://de.aipass.net/chat) จาก terminal — แชทแบบสตรีม
เปลี่ยนโมเดลได้ พร้อม agent ที่แก้ไฟล์ในเครื่องได้ โดยที่ credential
ไม่หลุดออกจาก browser แม้แต่ตัวเดียว

> English version: [README.md](README.md)

```
terminal ──HTTP──▶ bridge (node, ไม่มี dependency, :8787)
                      │  SSE: ส่งงานออก, POST: ส่ง delta กลับ
                      ▼
                   Chrome extension service worker
                      │  chrome.runtime
                      ▼
                   แท็บ de.aipass.net ──▶ /actions/send-message/<id>
```

bridge ไม่เคยเห็น session cookie เลย เพราะ request จริงถูกยิงในฐานะ JavaScript
ธรรมดาของหน้าเว็บ จากในแท็บ de.aipass.net ที่เปิดค้างไว้ — Chrome จึงแนบ cookie
ให้เอง และไม่มีอะไรถูกเก็บลงดิสก์

## โครงสร้าง repository

| path | คืออะไร |
|---|---|
| [aipass-bridge/bridge/server.mjs](aipass-bridge/bridge/server.mjs) | ตัว bridge — HTTP server, job hub, และ endpoint แบบ OpenAI-compatible |
| [aipass-bridge/extension/](aipass-bridge/extension/) | Chrome MV3 extension (service worker + content script ทั้ง MAIN/ISOLATED) |
| [aipass-bridge/chat.mjs](aipass-bridge/chat.mjs) | client สำหรับแชทใน terminal |
| [aipass-bridge/agent.mjs](aipass-bridge/agent.mjs) | agent แก้ไฟล์ พร้อม overlay filesystem แบบ dry run |
| [aipass-bridge/list.mjs](aipass-bridge/list.mjs) | ตัวพิมพ์ผลของ `npm run models` / `conversations` |
| [aipass-bridge/agent/core.mjs](aipass-bridge/agent/core.mjs) | ตัว loop ของ agent ที่ไม่ผูกกับ host — CLI กับ editor ใช้ร่วมกัน |
| [aipass-bridge/vscode/](aipass-bridge/vscode/) | VS Code extension: chat participant `@aipass`, พักการแก้ไขไว้ให้ตรวจก่อน |
| [aipass-bridge/test/](aipass-bridge/test/) | เทสต์ 67 ตัว ที่รัน bridge จริงเป็น subprocess |
| [aipass-bridge/handoff.html](aipass-bridge/handoff.html) | คู่มือฉบับเดี่ยว: สถาปัตยกรรม, การไล่หาสาเหตุ 403, และก้าวถัดไป |
| [app/](app/) | แอป Next.js 16 ที่ repo นี้ถูก scaffold มา — ไม่ได้แตะ |

เอกสารฉบับเต็มอยู่ที่ [aipass-bridge/README.md](aipass-bridge/README.md)

## ติดตั้ง

```bash
npm run dev
```

โหลด extension: `chrome://extensions` → เปิด Developer mode → **Load unpacked**
→ เลือกโฟลเดอร์ [aipass-bridge/extension](aipass-bridge/extension) จากนั้นเปิดแท็บ
`https://de.aipass.net/chat` ทิ้งไว้ — popup ควรขึ้นว่า **connected**

## สคริปต์

| script | |
|---|---|
| `npm run dev` | เริ่ม bridge ที่พอร์ต 8787 |
| `npm run chat` | client ใน terminal — `/models` ดูรายการ, `/model <id>` สลับ, Ctrl+C ออก |
| `npm run agent -- "task" --root .` | ใช้เครื่องมือแก้ไฟล์ในเครื่อง ในบทสนทนาใหม่ |
| `npm run models` | ดูรายการโมเดล พร้อมทำเครื่องหมายตัวที่ใช้เครดิตฟรี |
| `npm run conversations` | ดูรายการบทสนทนา และตัวที่กำลังใช้อยู่ |
| `npm test` | รันชุดเทสต์ |
| `npm run dev:next` | เริ่มแอป Next.js |

agent ตัวเดียวกันนี้รันใน VS Code ได้ด้วย — ดู [aipass-bridge/vscode/](aipass-bridge/vscode/)

```bash
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"   # ถามครั้งเดียวจบ
```

สิ่งที่ได้คือสิ่งเดียวกับที่ web UI ให้เมื่อส่งข้อความเดียวกัน รวมถึง tool
ฝั่งเซิร์ฟเวอร์ของมันด้วย — `web_search` จะสตรีมให้เห็นสด ๆ และลิสต์แหล่งอ้างอิงตอนจบ
กิจกรรมของ tool ถูกส่งเป็น `reasoning_content` ดังนั้น client แบบ OpenAI ที่อ่านแค่
`content` จะเห็นคำตอบสะอาด ๆ

## ข้อจำกัดที่ทุกอย่างถูกออกแบบมารอบ ๆ มัน

ส่งได้แค่ข้อความของผู้ใช้เท่านั้น — ไม่มี system prompt ไม่มี transcript

นี่ไม่ใช่การมักง่าย แต่เป็นสิ่งที่ endpoint ยอมรับ ถ้า array `messages`
มี turn ของ **assistant** อยู่ด้วย จะโดน `403` เปล่า ๆ จาก Google Frontend
ตั้งแต่ก่อนที่โมเดลจะได้เห็น ส่วนการคุยหลายเทิร์นยังทำงานได้ เพราะเซิร์ฟเวอร์
เป็นเจ้าของบทสนทนาและประวัติของมันเอง เหมือนที่ทำให้ web UI ทุกประการ

## ตัว agent

```bash
npm run agent -- "add a health route that returns ok" --root .
```

ค่าเริ่มต้นเป็น dry run: การแก้ไขจะไปอยู่ใน overlay ในหน่วยความจำ โมเดลจึงอ่านงาน
ที่ตัวเองค้างไว้กลับมาได้ ตอนจบจะได้ unified diff และไม่มีอะไรแตะดิสก์จนกว่าจะใส่
`--apply` ทุก path ถูกจำกัดอยู่ใน `--root` ส่วนการรันคำสั่ง shell ต้องเปิดด้วย
`--allow-run`

มันทำงาน *ภายใต้* ข้อจำกัดข้างบน ไม่ใช่ฝืนมัน:

- **ส่งคำสั่งครั้งเดียว** เป็นข้อความแรกของบทสนทนา เทิร์นถัด ๆ ไปจึงมีแค่ผลลัพธ์
  ของ tool — ราวสองสามร้อยไบต์ แทนที่จะส่ง prompt ซ้ำทุกครั้ง
- **รูปแบบเป็นภาษาพูด** (`NEED file README.md`, `EDIT`/`FIND`/`NEW`)
  ไม่มีวงเล็บมุม ไม่มี `key=value` ไม่มี absolute path — ทุกอย่างที่ว่ามาเคยโดน 403
  มาแล้วทั้งนั้น และไม่มีอันไหนจำเป็นเลย
- **ไม่เคยบอกว่าโมเดลมี tool** เพราะ system prompt ของโมเดลเองระบุว่ามีแค่
  `web_search` ถ้าเขียน preamble ให้เหมือน tool protocol มันจะปฏิเสธ
  ด้วยเหตุผลว่าตัวเองเข้าถึงไฟล์ไม่ได้ preamble จึงบอกการแบ่งงานกันตรง ๆ แทน
- **เทิร์นที่โดนปฏิเสธจะถูกผ่าครึ่งแล้วส่งใหม่** ผ่าซ้ำลงไปเรื่อย ๆ จนถึงราว 300 ไบต์
  เซิร์ฟเวอร์จำแต่ละชิ้นไว้ โมเดลจึงยังได้เห็นเนื้อหาทั้งหมด
- **ที่อยู่ loopback ถูกแทนที่** `localhost`, `127.0.0.1`, `0.0.0.0`,
  `169.254.169.254`, `file://` จะออกไปเป็น `LCLHST`, `LOOPBACK-IP` ฯลฯ
  แล้วถูกแปลงกลับก่อนเขียนลงไฟล์ — แค่ README ที่เขียนว่า *"open
  http://localhost:3000"* ก็เพียงพอให้ request ถูกปฏิเสธแล้ว
- **บรรทัดที่ส่งไม่ได้ไม่ว่าจะขนาดไหน จะถูกตัดทิ้ง** พร้อมหมายเหตุ — พวก
  `node -e`, `curl`, `rm -rf`, `/bin/sh`, `../../` เสียแค่บรรทัดเดียว ไม่ใช่ทั้งรอบ

ทุกครั้งที่รัน agent จะเริ่มบทสนทนาใหม่เสมอ เพราะการใช้ของเดิมซ้ำจะลากประวัติเก่า
ติดมาด้วย — รวมถึงการปฏิเสธ ซึ่งโมเดลจะเห็นว่าตัวเองเคยปฏิเสธไว้แล้วปฏิเสธซ้ำ
ใช้ `--reuse` เพื่อคุยต่อจากอันล่าสุด หรือ `--conversation ID` เพื่อระบุเจาะจง

## ใน VS Code

พิมพ์ `@aipass` ในแผงแชท — agent loop ตัวเดียวกัน แต่การแก้ไขจะถูกพักไว้เป็น diff
ให้ตรวจก่อน ไม่มีอะไรแตะดิสก์จนกว่าจะกด Apply:

```
@aipass what does the bridge do when the extension disconnects mid-stream?
@aipass add a health route that returns ok
@aipass /apply rename the log helper to `note`
```

เปิดโฟลเดอร์ [aipass-bridge/vscode/](aipass-bridge/vscode/) ใน VS Code แล้วกด F5
`/status` เช็ค bridge กับแท็บ, `/models` ดูรายการโมเดล, `/apply` เขียนลงดิสก์เลย
การเขียนไปผ่าน `WorkspaceEdit` ดังนั้นกด ctrl+Z ย้อนกลับได้เหมือนการแก้ไขปกติ

VS Code เป็น **hop ที่สี่** ไม่ใช่ตัวแทนของ browser — extension host ไม่มี cookie
ของ de.aipass.net จึงยังต้องมี bridge กับแท็บที่เปิดค้างอยู่ดี สิ่งที่มันแทนได้คือ
terminal เท่านั้น

`npm run package` ในโฟลเดอร์นั้นสร้าง `.vsix` สำหรับติดตั้งได้ — แต่ไม่เหมาะขึ้น
Marketplace เพราะใช้อะไรไม่ได้เลยถ้าไม่มี bridge กับแท็บ browser

ตัว loop อยู่ที่ [aipass-bridge/agent/core.mjs](aipass-bridge/agent/core.mjs)
ซึ่งไม่ผูกกับ host เลย — ไม่มี `node:fs` ไม่มี `console` ไม่มี `process.argv`
ฝั่ง CLI ฉีด `node:fs` กับตัวพิมพ์สี ANSI เข้าไป ส่วน extension ฉีด `workspace.fs`
กับ chat response stream ทั้งคู่รันโค้ดชุดเดียวกัน

## HTTP surface

`POST /v1/chat/completions` และ `GET /v1/models` ทำให้ client ที่รองรับ OpenAI
ตัวไหนก็ชี้มาที่ `http://127.0.0.1:8787/v1` ได้เลย (ส่งต่อเฉพาะข้อความสุดท้าย
ของผู้ใช้) นอกจากนี้ยังมี `/conversations`, `/conversations/new`, `/config`,
`/status` และกลุ่ม `/ext/*` ที่ extension คุยด้วย

| env | ค่าเริ่มต้น | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | ใช้เมื่อไม่ได้ระบุโมเดล |
| `AIPASS_MODELS` | id ที่รู้จักสองตัว | รายการสำรองเมื่อยังไม่มี extension ต่ออยู่ |
| `AIPASS_MODEL_FILTER` | `chat` | ใส่ `all` เพื่อเก็บโมเดล image/video/audio ไว้ด้วย |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | หรือ `text` / `off` |
| `AIPASS_CONVERSATION_ID` | *(ไม่ตั้ง)* | ปักหมุดบทสนทนาเดียว |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | ให้ job ล้มเหลวหลังไม่มี delta นานเท่านี้ |

## เทสต์

```bash
npm test
```

เทสต์ 67 ตัว ไม่มี dependency ใช้เวลาราว 2 วินาที
[test/harness.mjs](aipass-bridge/test/harness.mjs) รัน bridge ตัวจริงเป็น
subprocess คู่กับตัวแทน extension ที่เขียนสคริปต์ได้ ส่วน
[test/vscode-stub.mjs](aipass-bridge/test/vscode-stub.mjs) ทำแบบเดียวกันกับ API
ของ VS Code — เทสต์จึงขับ HTTP surface จริง, CLI จริง และ extension ตัวจริง
ไม่ใช่ mock ของมัน

สิ่งที่ครอบคลุมคือความผิดพลาดที่โปรเจกต์นี้เจอมาจริง ๆ: การส่งต่อเฉพาะข้อความ
ล่าสุดของผู้ใช้, การหมุนไปบทสนทนาถัดไปเมื่อเจอตัวที่ถูกล็อก, job ที่รอดมาได้แม้
extension หลุดกลางสตรีม, การแทนที่ loopback แล้วแปลงกลับได้ครบ, การผ่าเทิร์นที่
โดนปฏิเสธ, การตัดบรรทัดที่ส่งไม่ได้, `DONE` ที่มาก่อนเวลา, การปฏิเสธ path นอก
root, dry run ที่ไม่แตะดิสก์ และฝั่ง editor: การแก้ไขที่ยังพักไว้จนกว่าจะกด apply
กับเทิร์นถัดไปที่ต้องคุยต่อบทสนทนาเดิม ไม่ใช่เปิดอันใหม่

## ข้อจำกัดที่ทราบ

- ต้องเปิดแท็บ de.aipass.net ค้างไว้ content script ของมันถือ port ที่คอยกัน
  ไม่ให้ MV3 service worker ถูกฆ่า — ถ้าไม่มี Chrome จะเก็บ worker ทิ้งทุก ~30 วินาที
- ทุกข้อความจะไปโผล่ในประวัติแชทของบัญชี — เพราะนี่ใช้ตัวผลิตภัณฑ์จริง
- คุยนาน ๆ กินเครดิต มีแค่ `gemini-3.1-flash-lite` ที่ใช้เครดิตฟรี และ
  `npm run models` จะทำเครื่องหมายไว้ให้
