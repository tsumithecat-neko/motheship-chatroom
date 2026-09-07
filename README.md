# MOTHERSHIP // 通讯终端

局域网即时聊天 + Mothership（母舰）规则骰子引擎 + 角色卡档案库。零外部运行时依赖，Node 单文件即可跑，也可打包成双击即开的 exe。

- 实时消息（SSE 长连接，无需 WebSocket 库）
- 母舰风格骰子：`!roll` / `!d100` / `!check` / `!panic` / `!stress`，支持优势劣势
- 完整 d20 恐慌表 + 四职业创伤反应
- 多频道 + GM 权限（可见全部、建/改/删频道、静音、代投）
- 角色卡（按频道隔离，含装备与卡面图）
- 一键导出频道日志（.txt）

---

## 快速开始

### 方式一：双击启动（Windows，推荐）

双击 `start.bat`。脚本会优先使用同目录自带的 `node.exe`，无需本机安装 Node。

### 方式二：命令行

```bash
node server.js
```

### 方式三：单文件 exe

把 `build/mothership.exe` 拷到任意空文件夹双击运行。数据目录 `data/` 会自动生成在 **exe 同级目录**。

启动后终端会输出：

```
=== 母舰通讯终端已上线 ===
GM 口令 : warden
本机访问 : http://localhost:8080
局域网访问: http://192.168.x.x:8080
```

同网段设备（手机 / 笔记本 / 平板）浏览器打开「局域网访问」地址即可加入。

---

## 配置

| 项 | 默认值 | 改法 |
|---|---|---|
| 端口 | `8080` | 环境变量 `PORT`，例：`set PORT=3000 && node server.js` |
| GM 口令 | `warden` | 环境变量 `GM_CODE`，或直接改 `start.bat` 里的 `set "GM_CODE=..."` |
| 监听地址 | `0.0.0.0` | 固定，允许局域网访问 |

> ⚠️ 任何人输入正确 GM 口令即获得完整 GM 权限。跑团前请改口令。

---

## 玩家用法

1. 打开地址 → 输入**呼号**（≤20 字符）→ 点「接入频道」
2. GM 口令留空即为普通船员
3. 左侧切换频道，底部输入框发消息或投骰
4. 消息中 `@呼号` 会高亮并弹提示

### 骰子指令

输入框以 `!` 开头即为指令，也可用底部快捷按钮。

| 指令 | 说明 | 示例 |
|---|---|---|
| `!roll <表达式>` | 骰池，支持 `ndn` 与 `+/-` 常数 | `!roll 2d10+5` |
| `!r <表达式>` | 同上简写 | `!r 3d6-1` |
| `!d<n>` | 单骰 | `!d100`、`!d20` |
| `!check <目标值>` | d100 ≤ 目标值判定成败 | `!check 55` |
| `!panic` | Panic Check：d20 < Stress 则触发恐慌表 | `!panic` |
| `!stress` | 查询当前 Stress（默认 2） | `!stress` |
| `!stress <n>` | 设置 Stress（0–99） | `!stress 6` |
| `!help` | 指令速查 | `!help` |

**优势 / 劣势**：底部下拉框选「优势 Adv / 劣势 Dis」，或指令末尾手动加 `adv` / `dis`。

| 场景 | 优/劣势处理 |
|---|---|
| `!roll` / `!dN` | 投两组，优势取高、劣势取低，并展示另一组 |
| `!check` | 投两次 d100，优势取**低**、劣势取**高** |
| `!panic` | 投两次 d20，优势取**低**（更不易恐慌） |

**注意**：`!stress` 由服务端按「呼号」记忆，重启服务即清空；角色卡里的 Stress 字段是另一套，仅作记录。

### Panic Check 规则

- `d20 = 1` → FOCUS（获得优势）
- `d20 < 当前 Stress` → 触发恐慌表对应条目
- 否则 → 保持冷静，Stress -1（表内文字提示，需自行调整 `!stress`）
- 触发恐慌时，若当前频道角色卡填了职业，会附带对应创伤反应提示

职业匹配（中英文均可）：Scientist / 科学家、Teamster / 机械师 / 驾驶员、Android / 仿生人 / 机器人、Marine / 海军陆战队。

### 角色卡

点右上角「角色卡」：

- 填写属性（STR / SPD / INT / COM / SAN / FEA / BOD / ARM）、Stress、Wounds、备注、装备（每行一项）、卡面图
- 职业字段会被 `!panic` 读取用于创伤反应
- 卡片**按频道隔离**：不同频道可存不同的卡；`房间::呼号` 为唯一键
- 只能删除自己的卡；点击别人的卡可查看并载入到表单（再保存会存成你自己的）

---

## GM 用法

登录时在「GM 口令」框填入正确口令即可。

| 能力 | 说明 |
|---|---|
| 全频道视图 | 左侧顶部「全部频道」，同时看到所有频道消息流 |
| 频道管理 | 左下角「⚙ 管理频道」：新建、改名、设置白名单、静音、删除 |
| 白名单 | 「开放给」留空=所有人；填 `艾达,鲍勃` 则仅这两人可见 |
| 静音 | 频道行点「静音」→ 输入呼号，切换静音状态（被静音者仍能看，不能发） |
| 踢出 | 从白名单移除某人 → 该人立即被断开并踢回主频道 |
| 删除频道 | 该频道消息一并清除，成员被踢回主频道（主频道不可删） |
| 代投 | 指令末尾加 `@呼号`，结果归属到该呼号，消息标「代投」 |
| 导出 | 在「全部频道」视图点「导出」可得全频道日志 |

代投示例：

```
!check 55 @艾达        → 艾达的 55 检定
!panic @鲍勃          → 读取鲍勃角色卡职业，触发他的创伤反应
!roll 2d10+5 @艾达    → 艾达的伤害骰
```

非 GM 使用 `@` 会提示「只有 GM 可代投他人骰子」。

---

## 数据文件

运行时自动生成于 `data/`（`node server.js` 时在项目根；exe 时在 exe 同级）：

| 文件 | 内容 |
|---|---|
| `rooms.json` | 频道列表、白名单、静音名单 |
| `messages.json` | 消息记录，**每频道仅保留最近 500 条** |
| `characters.json` | 角色卡（含 base64 卡面图） |

备份 / 迁移：整个 `data/` 文件夹拷走即可。

---

## 目录结构

```
motheship-chatroom/
├── server.js            # HTTP + SSE + 骰子引擎，单文件后端
├── public/              # 前端
│   ├── index.html
│   ├── app.js
│   └── style.css
├── inline-assets.js     # 构建产物：public/ 的 base64 内联（供 exe 用）
├── build/
│   ├── make-exe.js      # 打包脚本
│   └── mothership.exe   # 单文件可执行版
├── data/                # 运行时数据（自动创建）
├── uploads/             # 预留
├── node.exe             # 便携 Node（Windows）
├── start.bat            # Windows 一键启动
└── package.json
```

---

## 打包 exe

```bash
node build/make-exe.js
```

流程：把 `public/` 全部内联生成 `inline-assets.js` → 用 `pkg` 打 `node18-win-x64` 单文件 exe 到 `build/mothership.exe`。

> 改过 `public/` 后必须重新打包，否则 exe 仍用旧前端。运行 `node server.js` 时始终读取 `public/`，不依赖 `inline-assets.js`。

---

## HTTP API

前端即通过这些接口通信，可自行扩展：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/events?room=&user=&gm=` | SSE 订阅；GM 传 `room=*` 收全部 |
| POST | `/api/send` | 发消息 / 指令 / `type:join` |
| GET | `/api/rooms?user=&gm=` | 频道列表 |
| POST | `/api/rooms` | 建频道（GM） |
| PUT | `/api/rooms/:id` | 改频道（GM） |
| DELETE | `/api/rooms/:id` | 删频道（GM） |
| POST | `/api/mute` | 静音开关（GM） |
| GET | `/api/characters?room=&gm=` | 读角色卡；`room=*` 需 GM |
| POST / DELETE | `/api/characters` | 存 / 删角色卡 |
| GET | `/api/roomlog?room=&user=&gm=` | 导出频道日志；`room=*` 需 GM |

---

## 常见问题

**局域网其他设备打不开** — Windows 防火墙放行 Node（或 exe）的入站：
```powershell
netsh advfirewall firewall add rule name="Mothership Chat" dir=in action=allow protocol=TCP localport=8080
```
另确认设备在同一网段、地址用的是「局域网访问」那行而非 localhost。

**端口被占用** — 换端口：`set PORT=8081 && node server.js`

**提示「离线 / 重连中」** — SSE 每 25 秒心跳保活；断线会自动重连，无需刷新。被 GM 移出频道时会收到系统提示并自动跳回主频道。

**消息丢失** — 每频道只存最近 500 条，超出的旧消息会被丢弃，重要内容及时「导出」。

**Stress 归零了** — `!stress` 存在内存，服务重启后回到默认 2。
