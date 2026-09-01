# aipass-bridge

ใช้ [de.aipass.net](https://de.aipass.net/chat) จาก terminal, จาก editor,
หรือจาก client ตัวไหนก็ได้ที่รองรับ OpenAI — โดยที่ credential ไม่หลุดออกจาก
browser แม้แต่ตัวเดียว

> English version: [README.md](README.md)

```
คุณ ──HTTP──▶ bridge (node, ไม่มี dependency, :8787)
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

**สารบัญ** — [ของที่ต้องมีก่อน](#ของที่ต้องมีก่อน) ·
[ติดตั้ง](#ติดตั้ง) · [แชทจาก terminal](#แชทจาก-terminal) ·
[ให้ agent แก้ไฟล์](#ให้-agent-แก้ไฟล์) · [VS Code](#vs-code) ·
[มินิแอพบน tray](#มินิแอพบน-tray) ·
[ต่อกับ client ที่รองรับ OpenAI](#ต่อกับ-client-ที่รองรับ-openai) ·
[บทสนทนา](#บทสนทนา) · [การตั้งค่า](#การตั้งค่า) ·
[แก้ปัญหา](#แก้ปัญหา) · [มันทำงานยังไง](#มันทำงานยังไง) ·
[เทสต์](#เทสต์) · [ข้อจำกัด](#ข้อจำกัดที่ทราบ)

---

## ของที่ต้องมีก่อน

| ต้องมี | เพราะอะไร |
|---|---|
| **Node 20+** | top-level await, `fetch` แบบ global, test runner ในตัว · ทดสอบบน v24.12.0 |
| **Google Chrome** | extension เป็น MV3 ต้องรันบน Chrome เท่านั้น ไม่มีตัวแทน — ดู [มันทำงานยังไง](#มันทำงานยังไง) |
| **บัญชี de.aipass.net ที่ใช้ได้จริง** | ต้องเปิด [de.aipass.net/chat](https://de.aipass.net/chat) แล้วส่งข้อความด้วยมือได้ก่อน |

ตัว bridge ไม่ต้อง `npm install` อะไรเลยเพราะไม่มี dependency · จะลงก็ต่อเมื่อ
อยากรันแอป Next.js ใน [app/](app/) ด้วย

> **ทุกข้อความที่ส่งจะไปโผล่ในประวัติแชทจริงของบัญชีนั้น** เพราะนี่ขับตัว
> ผลิตภัณฑ์จริง ไม่ใช่ sandbox

---

## ติดตั้ง

### 1 · เอาโค้ดมาแล้วเริ่ม bridge

```bash
git clone https://github.com/RikuAlice01/aipass-bridge.git
cd aipass-bridge
npm run dev
```

> อยากให้อยู่บน taskbar แทนที่จะเปิด terminal ค้าง? `npm run bridge:build` ได้
> `.exe` ขนาด 1.1 MB ที่รันอยู่ใน tray และไม่ต้องมี Node — ดู [มินิแอพบน tray](#มินิแอพบน-tray)

ควรเห็นแบบนี้:

```
aipass bridge on http://127.0.0.1:8787
  default model : gemini-3.1-flash-lite
  conversation  : most recent on the account
  waiting for the Chrome extension…
```

**เปิดค้างไว้** ทุกคำสั่งที่เหลือคุยกับตัวนี้

### 2 · โหลด Chrome extension

1. เปิด `chrome://extensions`
2. เปิด **Developer mode** (มุมขวาบน)
3. กด **Load unpacked**
4. เลือกโฟลเดอร์ [aipass-bridge/extension](aipass-bridge/extension)

### 3 · เปิดแท็บ de.aipass.net ทิ้งไว้

ไปที่ [https://de.aipass.net/chat](https://de.aipass.net/chat) ล็อกอินถ้ายัง
**เปิดแท็บนี้ค้างไว้** — ไม่มีแท็บนี้ bridge ทำงานไม่ได้ และถ้าปิดกลางคัน
ทุกอย่างหยุดทันที

### 4 · เช็คว่าใช้ได้จริง

กดไอคอน extension · popup ควรขึ้นว่า:

| ช่อง | ควรเห็นอะไร |
|---|---|
| การเชื่อมต่อ | จุดเขียว + **connected** |
| tab | `/chat` |
| jobs | `0` |
| Default model | dropdown มีรายการโมเดล |

จากนั้น:

```bash
npm run chat -- "hello"
```

ถ้าคำตอบสตรีมออกมา แปลว่าครบทั้งสี่ hop · ถ้ามีอะไรผิด ข้ามไปที่
[แก้ปัญหา](#แก้ปัญหา)

---

## แชทจาก terminal

### ถามครั้งเดียวจบ

```bash
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"
npm run chat -- "SSE กับ WebSocket ต่างกันยังไง"
```

### โหมดโต้ตอบ

```bash
npm run chat
```

```
aipass  model gemini-3.1-flash-lite  ·  conversation 7f3a1c9e2b5d4a80
/model <id> to switch  ·  /models to list  ·  Ctrl+C to quit

> aipass คืออะไร
```

| ในโหมดโต้ตอบ | |
|---|---|
| `/models` | ดูโมเดลทั้งหมดที่บัญชีใช้ได้ |
| `/model <id>` | สลับโมเดล และตั้งเป็นค่าเริ่มต้นของ bridge ด้วย |
| Ctrl+C | ออก |

### Flag

| flag | ค่าเริ่มต้น | |
|---|---|---|
| `--model <id>` | ค่าเริ่มต้นของ bridge | โมเดลสำหรับรอบนี้ |
| `--new` | ปิด | เริ่มบทสนทนาใหม่แทนที่จะคุยต่อ |
| `--conversation <id>` | อันล่าสุด | คุยต่อบทสนทนาที่ระบุ |
| `--bridge <url>` | `http://127.0.0.1:8787` | bridge อยู่ไหน |

```bash
npm run chat -- --model claude-sonnet-5@default "อธิบายโค้ดเบสนี้ให้หน่อย"
npm run chat -- --new                  # เริ่มใหม่หมด แบบโต้ตอบ
```

### ได้อะไรบ้าง

ได้เหมือนที่ web UI ให้เมื่อส่งข้อความเดียวกัน **รวมถึง tool ฝั่งเซิร์ฟเวอร์ของมัน**
`web_search` จะสตรีมให้เห็นสด ๆ และลิสต์แหล่งอ้างอิงตอนจบ:

```
[web_search] {"query":"aipass.go.th"}
[web_search] returned 4821 chars
AiPASS เป็นแพลตฟอร์มภายใต้โครงการ TH-AI Passport …
sources:
  - Aipass https://aipass.go.th/
```

กิจกรรมของ tool ถูกส่งเป็น `reasoning_content` ดังนั้น client แบบ OpenAI ที่อ่าน
แค่ `content` จะเห็นคำตอบสะอาด ๆ · เปลี่ยนได้ที่
[`AIPASS_TOOL_VISIBILITY`](#การตั้งค่า)

---

## ให้ agent แก้ไฟล์

```bash
npm run agent -- "add a health route that returns ok" --root .
```

**ค่าเริ่มต้นเป็น dry run** การแก้ไขไปอยู่ใน overlay ในหน่วยความจำ โมเดลจึงอ่านงาน
ที่ตัวเองค้างไว้กลับมาได้ · ตอนจบได้ unified diff และไม่มีอะไรแตะดิสก์ ·
ใส่ `--apply` ถึงจะเขียนจริง

### ตัวอย่างรันเต็ม ๆ

```bash
npm run agent -- "what does the bridge do when the extension disconnects?" --root .
```

```
task  what does the bridge do when the extension disconnects?
root  E:\github\aipass-bridge
mode  dry run (pass --apply to write)
chat  a41f2c8b91d3e07f  (new)

─── step 1/10 ────────────────────────────────
  ✓ list . README.md
─── step 2/10 ────────────────────────────────
  ✓ read aipass-bridge/bridge/server.mjs // Local bridge to de.aipass.net's chat.

✓ The job is kept and retried on the next client; it only fails after
  AIPASS_IDLE_TIMEOUT_MS with no delta.

no file changes
```

ตอนที่มันแก้อะไรจริง ๆ:

```
1 file(s) changed:

--- a/app/health/route.ts
+++ b/app/health/route.ts
@@ -1,0 +1,3 @@
+export function GET() {
+  return Response.json({ ok: true });
+}

dry run — nothing written. re-run with --apply
```

### Flag

| flag | ค่าเริ่มต้น | |
|---|---|---|
| `--root <dir>` | cwd | โฟลเดอร์เดียวที่ agent อ่าน/เขียนได้ |
| `--apply` | ปิด | เขียนลงดิสก์จริง |
| `--model <id>` | ค่าเริ่มต้นของ bridge | โมเดลสำหรับรอบนี้ |
| `--max <n>` | `10` | จำนวนรอบอ่าน/แก้ก่อนหยุด |
| `--max-result <n>` | `3000` | ตัดผลลัพธ์แต่ละ tool ที่กี่ไบต์ |
| `--allow-run` | ปิด | ให้โมเดลรันคำสั่ง shell ได้ |
| `--reuse` | ปิด | คุยต่อบทสนทนาล่าสุด |
| `--conversation <id>` | — | คุยต่อบทสนทนาที่ระบุ |
| `--bridge <url>` | `http://127.0.0.1:8787` | bridge อยู่ไหน |

### เรื่องที่ควรรู้

- **`--root` เป็นเส้นตาย** path ที่หลุดออกไปจะถูกปฏิเสธ ไม่ใช่ดึงกลับ ·
  รันจากโปรเจกต์ที่ตั้งใจจริง ๆ
- **ทุกครั้งที่รันจะเริ่มบทสนทนาใหม่** ถ้าไม่ใส่ `--reuse` หรือ `--conversation` ·
  การใช้ของเดิมซ้ำจะลากประวัติเก่าติดมา รวมถึงการปฏิเสธ ซึ่งโมเดลจะเห็นว่าตัวเอง
  เคยปฏิเสธไว้แล้วปฏิเสธซ้ำ
- **`--allow-run` อันตรายจริง** โมเดลเป็นคนเลือกคำสั่ง แล้วมันรันใน shell ของคุณ
  ที่ `--root` · ปิดไว้เถอะ ถ้าไม่ได้นั่งดูอยู่
- **`--max-result` มีไว้เพราะตัวกรองฝั่งต้นทาง** ไม่ใช่แค่เรื่องค่า token ·
  ตั้งสูงขึ้น = โดนปฏิเสธง่ายขึ้น
- ดู diff ก่อน `--apply` เสมอ โมเดลเขียนทีละช่วงบรรทัด

---

## VS Code

แผงแชทของตัวเองบน activity bar ใช้ agent loop ตัวเดียวกัน · การแก้ไขจะถูกพักไว้
และแสดงเป็น diff ก่อน ไม่มีอะไรแตะดิสก์ · `@aipass` ในแผงแชทของ VS Code เองก็ยังใช้ได้

### รันจากซอร์ส

เปิดโฟลเดอร์ [aipass-bridge/vscode/](aipass-bridge/vscode/) ใน VS Code แล้วกด **F5**
จะมีหน้าต่าง Extension Development Host เปิดขึ้นมาพร้อม participant

### หรือติดตั้งจริง

```bash
cd aipass-bridge/vscode
npm run package          # -> aipass-bridge-vscode-0.1.0.vsix
```

แล้วใช้ **Extensions: Install from VSIX…** ใน command palette

### วิธีใช้

กดไอคอน AI Bridge บน activity bar · Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่ ·
กิจกรรมของ tool ถูกพับเป็นบล็อก **steps** การแก้ไขมาเป็นรายการพร้อม
**Review** / **Apply** / **Discard** และ **New chat** เปิดบทสนทนาใหม่ ·
แผงนี้ใช้ธีมของ editor ไม่ได้ตั้งสีของตัวเอง

บทสนทนาและ conversation ที่ผูกอยู่ถูกเก็บใน `workspaceState` ของ VS Code ·
reload แล้วแผงยังอยู่ที่เดิม และเทิร์นถัดไปคุยต่อ conversation เดิม · **New chat**
ล้างทิ้ง

มี dropdown ให้เลือกโมเดล — เขียนลง setting `aipass.model` ไม่ได้ไปขยับ default
ของ bridge จึงไม่กระทบสิ่งที่ CLI ได้

มีสองโหมด: **Agent** อ่าน/แก้ไฟล์ ส่วน **Ask** ส่งคำถามตรงเข้าโมเดล ไม่มี preamble
ไม่มี tool — เหมาะกับอะไรที่ไม่เกี่ยวกับโค้ด · ภายในบทสนทนาเดียว คำสั่งถูกส่งครั้งเดียว
เทิร์นถัดไปจึงมีแค่คำถาม

แบบเดิมผ่านแผงแชทของ VS Code เอง:

```
@aipass /status
@aipass what does the bridge do when the extension disconnects mid-stream?
@aipass add a health route that returns ok
@aipass /apply rename the log helper to `note`
```

ลอง `@aipass /status` ก่อนเป็นอันดับแรก มันบอกว่า bridge ขึ้นมั้ยและมีแท็บต่ออยู่มั้ย
ซึ่งเป็นสาเหตุของความสับสนเกือบทั้งหมด

| คำสั่ง | |
|---|---|
| `/status` | bridge ติดต่อได้มั้ย · มีแท็บต่อมั้ย · ใช้บทสนทนาไหน |
| `/models` | บัญชีใช้โมเดลอะไรได้บ้าง อันไหนเครดิตฟรี |
| `/apply` | รันงานแล้วเขียนลงดิสก์เลย |

ถ้าไม่ใส่ `/apply` การแก้ไขจะถูกพักไว้ พร้อมปุ่ม **Review** (เปิด diff editor ของจริง),
**Apply** และ **Discard** · การเขียนไปผ่าน `WorkspaceEdit` กด ctrl+Z ย้อนได้
เหมือนการแก้ไขปกติ

### การตั้งค่า

| setting | ค่าเริ่มต้น | |
|---|---|---|
| `aipass.bridge` | `http://127.0.0.1:8787` | bridge อยู่ไหน |
| `aipass.model` | *(ว่าง)* | ว่าง = ใช้ค่าเริ่มต้นของ bridge |
| `aipass.maxSteps` | `10` | รอบอ่าน/แก้ต่อหนึ่ง request |
| `aipass.maxResult` | `3000` | ไบต์ต่อผลลัพธ์ tool ที่ส่งขึ้นไป |
| `aipass.allowRun` | `false` | ให้ agent ส่งคำสั่งเข้า terminal ได้ |
| `aipass.showModelMarkers` | `false` | โชว์ protocol ดิบ `NEED`/`EDIT`/`DONE` |

`allowRun` ส่งคำสั่งเข้า terminal ชื่อ **aipass** ที่มองเห็นได้ และผลลัพธ์
**ไม่ถูกอ่านกลับ**เข้าบทสนทนา — โมเดลไม่เห็นว่าที่รันไปได้ผลอะไร

session แชทหนึ่งอันผูกกับ conversation หนึ่งอัน เทิร์นแรกเปิด เทิร์นหลังคุยต่อ ·
อยากได้อันสะอาดก็เปิดแชทใหม่

รายละเอียดที่ [aipass-bridge/vscode/README.md](aipass-bridge/vscode/README.md)

---

## มินิแอพบน tray

bridge มีอีกร่างเป็น .exe ไฟล์เดียวที่อยู่บน taskbar ของ Windows จะได้ไม่ต้องเปิด
terminal ค้างไว้:

```bash
npm run bridge:build     # -> aipass-bridge/rust/target/release/aipass-bridge.exe
npm run bridge:tray      # build แล้วรันเลย
```

ดับเบิลคลิกแล้วมันไปอยู่ใน tray · เอาเมาส์ชี้เพื่อดูสถานะ — **ยังไม่มีแท็บต่อ**,
**พร้อม · n แท็บ** หรือ **มี n งานกำลังวิ่ง** · เมนูบอกว่าใช้ conversation ไหน
พร้อม **Copy bridge URL**, **Open de.aipass.net/chat** และ **Quit**

`logo.png` ที่ root เป็น artwork ตัวเดียวของทั้งโปรเจกต์ ·
[tools/icons.py](tools/icons.py) สร้างที่เหลือจากมันทั้งหมด — `icon.ico`
หลายขนาดที่ฝังเข้า `.exe` และ PNG ของ extension ทั้งสองตัว · เปลี่ยนโลโก้แล้ว
รันสคริปต์นี้ ไม่มีอะไรแก้ด้วยมือ

เป็นการ port ไม่ใช่เขียนใหม่: route เดิม, ตัวแปร `AIPASS_*` เดิม, พฤติกรรมเดิม
และไม่มี credential มาถึงมันเหมือนกัน · วิธีที่ยืนยันว่าเทียบเท่าจริง — **ไม่มี
ชุดเทสต์ที่สอง** ชุดเดิมรันกับทั้งสองตัว:

```bash
npm test            # 98 ตัว กับ Node bridge
npm run test:rust   # 98 ตัวเดิม กับตัว Rust
```

รายละเอียดที่ [aipass-bridge/rust/README.md](aipass-bridge/rust/README.md)

## ต่อกับ client ที่รองรับ OpenAI

bridge เปิด `POST /v1/chat/completions` และ `GET /v1/models` ไว้:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.1-flash-lite","messages":[{"role":"user","content":"hello"}]}'
```

สตรีมก็ได้ — ใส่ `"stream": true` จะได้ SSE มาตรฐานที่จบด้วย `data: [DONE]`

ชี้ SDK ตัวไหนมาก็ได้:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
client.chat.completions.create(model="gemini-3.1-flash-lite",
                               messages=[{"role": "user", "content": "hello"}])
```

ไม่มี auth เพราะ bridge ผูกกับ `127.0.0.1` และ credential อยู่ใน browser
`api_key` จะใส่อะไรก็ได้

> **ส่งต่อเฉพาะข้อความสุดท้ายของผู้ใช้** system prompt หรือ turn ของ assistant
> ที่อยู่ใน `messages` จะถูกทิ้ง ไม่ได้ส่งไป · นี่เป็นข้อจำกัดจริงของ endpoint
> ไม่ใช่การมักง่าย — ดู [มันทำงานยังไง](#มันทำงานยังไง) · คุยหลายเทิร์นยังได้
> เพราะเซิร์ฟเวอร์จำบทสนทนาเอง

ถ้า model id ขึ้นต้นด้วย `aipass/` จะถูกตัดออกให้ สำหรับ client ที่บังคับให้มี
prefix ของผู้ให้บริการ

---

## บทสนทนา

เซิร์ฟเวอร์เป็นเจ้าของประวัติบทสนทนา เหมือนที่ทำให้ web UI ทุกประการ

```bash
npm run conversations
```

```
* 7f3a1c9e2b5d4a80  2026-08-31T14:22  Bridge questions
  a41f2c8b91d3e07f  2026-08-31T09:05  New chat
```

`*` คืออันที่กำลังใช้ · ถ้าอยากสร้างใหม่โดยไม่ต้องส่งข้อความจริง:

```bash
curl -s localhost:8787/conversations/new \
  -H 'content-type: application/json' -d '{"message":"hello"}'
```

อันไหนถูกใช้:

| | |
|---|---|
| `npm run chat` | อันล่าสุด เพื่อให้แชทเป็นแชท |
| `npm run chat -- --new` | อันใหม่ |
| `npm run agent` | **อันใหม่เสมอ** ถ้าไม่ใส่ `--reuse`/`--conversation` |
| VS Code | หนึ่ง conversation ต่อหนึ่ง session แชท |
| `AIPASS_CONVERSATION_ID` | ปักหมุดอันเดียว ทับทุกข้อข้างบน |

ถ้าบทสนทนาไหนรับข้อความไม่ได้แล้ว — `404` เมื่อถูกลบ, `409` เมื่อเซิร์ฟเวอร์ยังคิดว่า
กำลังตอบอยู่ — bridge จะย้ายไปอันถัดไปเอง

---

## การตั้งค่า

| env | ค่าเริ่มต้น | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_HOST` | `127.0.0.1` | |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | ใช้เมื่อไม่ได้ระบุโมเดล |
| `AIPASS_MODELS` | id ที่รู้จักสองตัว | รายการสำรองเมื่อยังไม่มี extension ต่ออยู่ |
| `AIPASS_MODEL_FILTER` | `chat` | ใส่ `all` เพื่อเก็บโมเดล image/video/audio ไว้ด้วย |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` แทรกในเนื้อคำตอบ, `off` ตัดทิ้ง |
| `AIPASS_CONVERSATION_ID` | *(ไม่ตั้ง)* | ปักหมุดบทสนทนาเดียว |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | ให้ job ล้มเหลวหลังไม่มี delta นานเท่านี้ |

```bash
AIPASS_PORT=9000 AIPASS_TOOL_VISIBILITY=off npm run dev
```

popup เปลี่ยนโมเดลเริ่มต้นกับ URL ของ bridge ได้ตอนรันด้วย

### สคริปต์ทั้งหมด

| script | |
|---|---|
| `npm run dev` | เริ่ม bridge ที่พอร์ต 8787 |
| `npm run chat` | client ใน terminal |
| `npm run agent -- "task" --root .` | เครื่องมือแก้ไฟล์ในเครื่อง |
| `npm run models` | ดูรายการโมเดล พร้อมทำเครื่องหมายตัวที่ใช้เครดิตฟรี |
| `npm run conversations` | ดูรายการบทสนทนา และตัวที่กำลังใช้อยู่ |
| `npm test` | รันชุดเทสต์ |
| `npm run bridge:build` | build มินิแอพ Rust |
| `npm run bridge:tray` | build แล้วรัน |
| `npm run test:rust` | รันชุดเทสต์กับ bridge ตัว Rust |
| `npm run dev:next` | เริ่มแอป Next.js ใน [app/](app/) |

---

## แก้ปัญหา

| เห็นอะไร | แปลว่าอะไร | ทำยังไง |
|---|---|---|
| `No bridge at http://127.0.0.1:8787` | bridge ไม่ได้รันอยู่ | `npm run dev` |
| `The extension is not connected` | ไม่มีแท็บ de.aipass.net หรือ Chrome เก็บ worker ไปแล้ว | เปิด [de.aipass.net/chat](https://de.aipass.net/chat) แล้วดูว่า popup ขึ้น **connected** |
| `no extension connected — open a de.aipass.net tab and check the popup` | แท็บถูกปิดกลางคัน | เปิดใหม่แล้วลองอีกครั้ง |
| popup: `bridge not reachable — is server.mjs running?` | เหมือนแถวแรก แต่มองจากฝั่ง browser | `npm run dev` แล้วกด **Refresh** ใน popup |
| popup ขึ้น **not connected** ทั้งที่เปิดแท็บอยู่ | แท็บเปิดมาก่อน extension หรือ Chrome ทิ้งแท็บไปแล้ว | รีโหลดแท็บ de.aipass.net |
| คำตอบหยุดกลางทางแล้วเงียบไป | ไม่มี delta นานเกิน `AIPASS_IDLE_TIMEOUT_MS` | เช็คว่าแท็บยังอยู่ · คำตอบยาว ๆ ให้เพิ่มค่า timeout |
| `Conversation not found` | id ถูกลบไปแล้วหรือมั่วขึ้นมา | `npm run conversations` ดูของจริง หรือใช้ `--new` |
| `403 … CHAT_UNAUTHORIZED … Conversation has been deleted` | บทสนทนานั้นถูกลบไปแล้วในบัญชี | ไม่ต้องทำอะไร bridge หมุนไปอันถัดไปเอง |
| agent: `rejected — splitting into 2 parts` | ไฟล์ไปโดนตัวกรองฝั่งต้นทาง | ไม่ต้องทำอะไร มันกู้เอง |
| agent: `omitting 1 line(s) that cannot be sent` | มีบรรทัดหน้าตาเหมือน code execution | ปกติ · ส่วนที่เหลือของไฟล์ยังผ่านไปได้ |
| agent: `this fragment was rejected even on its own` | บรรทัดเดียวที่ผ่านไม่ได้ไม่ว่าจะขนาดไหน | มันพิมพ์ออกมาให้ดูว่าบรรทัดไหน |
| agent: `no marker after three replies` | โมเดลหลุดออกจาก protocol | ลอง `--model` ตัวอื่น หรือรันใหม่ — แต่ละรอบเป็นบทสนทนาใหม่อยู่แล้ว |
| agent: `path escapes root` | โมเดลขอไฟล์นอก `--root` | ทำงานถูกต้องแล้ว |
| VS Code: `Cannot reach aipass` | bridge หรือแท็บ | `@aipass /status` บอกว่าอันไหน |
| VS Code: `Open a folder first` | ไม่ได้เปิด workspace folder | เปิดโฟลเดอร์โปรเจกต์ ไม่ใช่เปิดไฟล์เดี่ยว ๆ |

**เทสต์รันไม่ขึ้นเลย** — น่าจะยังอยู่บน checkout เก่า · ทั้งบั๊ก path บน Windows
ใน harness และ `process.exit` ที่ทำให้ `chat.mjs` ตาย แก้แล้วทั้งคู่ ·
รัน `npm test` ควรได้ 98 ผ่านในราวสองวินาที

---

## มันทำงานยังไง

### ทำไม browser ถึงตัดออกไม่ได้

การยืนยันตัวตนคือ session cookie แบบ same-origin · `page.js` ของ extension รันใน
**MAIN world** ของแท็บ de.aipass.net ดังนั้น `fetch` ของมันคือ first-party request
ของจริง Chrome จึงแนบ cookie ให้เอง — bridge ไม่เคยเห็น และไม่มีอะไรลงดิสก์

ส่วน socket ที่ต่อกับ bridge อยู่ใน **service worker** แทน เพราะหน้า `https://`
ที่คุยกับ `http://127.0.0.1` จะไปติด mixed-content กับ Private Network Access
ซึ่ง request จาก extension ไม่ติด · content script ยังถือ port ค้างไว้ด้วย เพราะ
Chrome เก็บ MV3 worker ที่ว่างงานทิ้งทุก ~30 วินาที และข้อมูล SSE ขาเข้าไม่นับ
ว่าเป็นกิจกรรม

### ข้อจำกัดที่ทุกอย่างถูกออกแบบรอบ ๆ มัน

ส่งได้แค่ข้อความของผู้ใช้เท่านั้น — ไม่มี system prompt ไม่มี transcript

นั่นคือสิ่งที่ endpoint ยอมรับ · ถ้า array `messages` มี turn ของ **assistant**
จะโดน `403` เปล่า ๆ จาก Google Frontend ตั้งแต่ก่อนโมเดลจะได้เห็น ·
คุยหลายเทิร์นได้เพราะเซิร์ฟเวอร์เป็นเจ้าของบทสนทนา

ตัว agent อยู่ *ภายใต้* ข้อนี้แทนที่จะฝืน: ส่งคำสั่งครั้งเดียวเป็นข้อความแรก ·
รูปแบบ marker เป็นภาษาพูดเพราะทุกรูปแบบที่มีโครงสร้างเคยโดน 403 · เทิร์นที่โดน
ปฏิเสธจะถูกผ่าครึ่งแล้วส่งใหม่ · `localhost` และพวกพ้องถูกแทนที่ขาออกเพราะ
ตัวกรอง SSRF จับคำพวกนี้ · และบรรทัดที่ส่งไม่ได้ไม่ว่าขนาดไหนจะถูกตัดทิ้ง
พร้อมหมายเหตุ แทนที่จะทำให้ทั้งรอบล้ม

ทุกข้อคือแผลเป็น · เหตุผลอยู่ใน [aipass-bridge/README.md](aipass-bridge/README.md)
และการไล่หาสาเหตุอยู่ใน [aipass-bridge/handoff.html](aipass-bridge/handoff.html)

### โครงสร้าง

| path | |
|---|---|
| [aipass-bridge/bridge/server.mjs](aipass-bridge/bridge/server.mjs) | ตัว bridge — HTTP server, job hub, OpenAI surface |
| [aipass-bridge/extension/](aipass-bridge/extension/) | Chrome MV3 extension |
| [aipass-bridge/agent/core.mjs](aipass-bridge/agent/core.mjs) | ตัว loop ของ agent ที่ไม่มี host อยู่ข้างใน |
| [aipass-bridge/agent.mjs](aipass-bridge/agent.mjs) | หน้า CLI ของมัน |
| [aipass-bridge/chat.mjs](aipass-bridge/chat.mjs) | client แชทใน terminal |
| [aipass-bridge/vscode/](aipass-bridge/vscode/) | VS Code extension |
| [aipass-bridge/rust/](aipass-bridge/rust/) | bridge ตัวเดียวกันในภาษา Rust เป็นแอพบน tray |
| [aipass-bridge/test/](aipass-bridge/test/) | เทสต์ 98 ตัว |
| [app/](app/) | แอป Next.js ที่ repo นี้ถูก scaffold มา — ไม่ได้แตะ |

---

## เทสต์

```bash
npm test
```

เทสต์ 98 ตัว ไม่มี dependency ใช้เวลาราวสองวินาที ·
[test/harness.mjs](aipass-bridge/test/harness.mjs) รัน bridge ตัวจริงเป็น
subprocess คู่กับตัวแทน extension ที่เขียนสคริปต์ได้ ส่วน
[test/vscode-stub.mjs](aipass-bridge/test/vscode-stub.mjs) ทำแบบเดียวกันกับ API
ของ VS Code — เทสต์จึงขับ HTTP surface จริง, CLI จริง และ extension ตัวจริง
ไม่ใช่ mock ของมัน

สิ่งที่ครอบคลุมคือความผิดพลาดที่โปรเจกต์นี้เจอมาจริง ๆ: การส่งต่อเฉพาะข้อความ
ล่าสุดของผู้ใช้, การหมุนไปบทสนทนาถัดไปเมื่อเจอตัวที่ถูกล็อก, job ที่รอดมาได้แม้
extension หลุดกลางสตรีม, การแทนที่ loopback แล้วแปลงกลับได้ครบ, การผ่าเทิร์นที่
โดนปฏิเสธ, การตัดบรรทัดที่ส่งไม่ได้, `DONE` ที่มาก่อนเวลา, การปฏิเสธ path นอก
root, dry run ที่ไม่แตะดิสก์, การแก้ไขฝั่ง editor ที่ยังพักไว้จนกว่าจะกด apply
และ layout ของ `.vsix` ที่ต้องโหลดได้จริง

---

## ข้อจำกัดที่ทราบ

- **ต้องเปิดแท็บ de.aipass.net ค้างไว้** ปิดเมื่อไรทุกอย่างหยุด
- **ทุกข้อความไปโผล่ในประวัติแชทของบัญชี** เพราะนี่คือผลิตภัณฑ์จริง
- **คุยนาน ๆ กินเครดิต** มีแค่ `gemini-3.1-flash-lite` ที่ใช้เครดิตฟรี ·
  `npm run models` ทำเครื่องหมายไว้ให้
- **ไม่มี system prompt ไม่มี transcript** ดู
  [ข้อจำกัด](#ข้อจำกัดที่ทุกอย่างถูกออกแบบรอบ-ๆ-มัน)
- **VS Code extension ไม่เหมาะขึ้น Marketplace** เพราะใช้อะไรไม่ได้เลยถ้าไม่มี
  bridge กับแท็บ browser
- **Chrome เท่านั้น** extension เป็น MV3 และเรื่อง credential ทั้งหมดขึ้นกับมัน
