// 手机版 DOM 冒烟测试：用 jsdom 跑一遍 index.html + map.js + app.js，抓加载期 JS 错误
const fs = require('fs');
const { JSDOM } = require('jsdom');

const PUB = 'C:/Users/saphi/OneDrive/文档/GitHub/motheship-chatroom/public';
let html = fs.readFileSync(PUB + '/index.html', 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');

const errors = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:8123/' });
const w = dom.window;

// 屏蔽 jsdom 未实现的浏览器能力（canvas / fetch / SSE），避免噪音
w.HTMLCanvasElement.prototype.getContext = function () { return null; };
w.fetch = () => new Promise(() => {});
w.EventSource = function () { this.close = () => {}; };
w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;

w.onerror = (m, s, l, c, err) => { errors.push('onerror: ' + m + (err && err.stack ? '\n' + err.stack : '')); };
w.addEventListener('error', (e) => { errors.push('event error: ' + (e.message || e.type)); });

function run(file) {
  // 去掉文件头的 'use strict'，否则间接 eval 里的函数声明不会挂到 window 上，测试拿不到
  const src = fs.readFileSync(PUB + '/' + file, 'utf8').replace(/^\s*['"]use strict['"];?/, '');
  try { w.eval(src); }
  catch (e) { errors.push(file + ' 抛错: ' + e.message + '\n' + (e.stack || '')); }
}

// 场景 1：默认（桌面）
run('map.js'); run('app.js');
const body = w.document.body;
console.log('[1] 默认模式 body.class =', JSON.stringify(body.className), '| 期望不含 mobile');

// 场景 2：设置里选手机版
const sel = w.document.getElementById('setViewMode');
sel.value = 'mobile';
try { sel.dispatchEvent(new w.Event('change')); } catch (e) { errors.push('view select: ' + e.message); }
console.log('[2] 切手机版 body.class =', JSON.stringify(body.className), '| 期望含 mobile');
console.log('    localStorage =', w.localStorage.getItem('mothership_view'), '| 期望 mobile');
console.log('    标签栏存在 =', !!w.document.querySelector('#mobileTabs .mt[data-tab="radar"]'));

// 场景 3：点「雷达」标签
const radarBtn = w.document.querySelector('#mobileTabs .mt[data-tab="radar"]');
try { radarBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } catch (e) { errors.push('radar click: ' + e.message); }
console.log('[3] 点雷达后 body.class =', JSON.stringify(body.className), '| 期望含 tab-radar');

// 场景 4：点「更多」应开抽屉且不改标签
const moreBtn = w.document.querySelector('#mobileTabs .mt[data-tab="more"]');
try { moreBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } catch (e) { errors.push('more click: ' + e.message); }
const sheet = w.document.getElementById('mSheet');
console.log('[4] 更多抽屉 hidden =', sheet.classList.contains('hidden'), '| 期望 false');
console.log('    抽屉条目数 =', w.document.querySelectorAll('#mSheetList .ms-item').length, '| 期望 5');
console.log('    点更多后 body 仍为 =', JSON.stringify(body.className));

// 场景 4.5：雷达页下从「更多」点指令手册 → 应切回通讯页并显示手册
{
  const items = Array.from(w.document.querySelectorAll('#mSheetList .ms-item'));
  const helpItem = items.find((b) => b.textContent.indexOf('指令手册') >= 0);
  console.log('[4.5] 找到指令手册条目 =', !!helpItem, '| 点击前 body =', JSON.stringify(body.className));
  try { helpItem.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
  catch (e) { errors.push('help item click: ' + e.message); }
  const hasRadarCls = body.classList.contains('tab-radar');
  const sysHelp = w.document.querySelectorAll('#log .system.sys-help').length;
  console.log('      点击后 body =', JSON.stringify(body.className), '| tab-radar 应为 false（实际', hasRadarCls, '）');
  console.log('      抽屉已关 =', sheet.classList.contains('hidden'), '| 期望 true');
  console.log('      聊天流内手册条数 =', sysHelp, '| 期望 ≥1');
  if (hasRadarCls) errors.push('点指令手册后仍停留在雷达页（body 仍有 tab-radar）');
  if (!sysHelp) errors.push('点指令手册后聊天流里没有手册内容');
}

// 场景 5.5：CSS 层叠检查（雷达页侧栏应显示，通讯页应隐藏）
// 手动挂上样式表（jsdom 不会自动拉取外链）
const st = w.document.createElement('style');
st.textContent = fs.readFileSync(PUB + '/style.css', 'utf8');
w.document.head.appendChild(st);

const panel = w.document.getElementById('sidePanel');
const tabs = w.document.getElementById('mobileTabs');
function disp(el) { return w.getComputedStyle(el).display; }

const login = w.document.getElementById('login');
body.classList.add('mobile', 'tab-radar');
console.log('[5.5a] 登录页:   #mobileTabs display =', disp(tabs), '| 期望 none（未登录不该有标签栏）');
login.classList.add('hidden');                       // 模拟已登录
console.log('[5.5b] mobile+雷达: #sidePanel display =', disp(panel), '| 期望 flex');
console.log('                    #mobileTabs display =', disp(tabs), '| 期望 flex');
console.log('                    #miniMapExits 存在 =', !!w.document.getElementById('miniMapExits'));
console.log('                    #mRadarFx 存在 =', !!w.document.getElementById('mRadarFx'));
body.classList.remove('tab-radar');
console.log('      mobile+通讯:  #sidePanel display =', disp(panel), '| 期望 none');
body.classList.remove('mobile');
console.log('      desktop:      #mobileTabs display =', disp(tabs), '| 期望 none');

// 场景 6：设置里切回桌面版
const sel5 = w.document.getElementById('setViewMode');
sel5.value = 'desktop';
try { sel.dispatchEvent(new w.Event('change')); } catch (e) { errors.push('view select: ' + e.message); }
console.log('[5] 选桌面版 body.class =', JSON.stringify(body.className), '| 期望不含 mobile');
console.log('    localStorage 记录 =', w.localStorage.getItem('mothership_view'), '| 期望 desktop');

setTimeout(() => {
  console.log('\n=== JS 错误 ===');
  if (!errors.length) console.log('无');
  else errors.forEach((e) => console.log('- ' + e));
  process.exit(errors.length ? 1 : 0);
}, 500);
