/*
 * VPS到期监控系统 - Cloudflare Workers
 * 使用KV存储域名信息
 */

// ==========================================
// 1. 配置常量
// ==========================================

// iconfont 阿里巴巴图标库配置
const ICONFONT_CSS_URL = "//at.alicdn.com/t/c/font_4988916_94yhwx8dzq.css";
const ICONFONT_JS_URL = "//at.alicdn.com/t/c/font_4988916_94yhwx8dzq.js";

// 登录认证配置
const AUTH_PASSWORD = "";             // 登录密码，或留空使用其他方式配置，可选择外置变量PASS，都留空则不启用登录验证

// Telegram通知配置
const TELEGRAM_BOT_TOKEN = "";        // 在此填写Telegram Bot Token，或留空使用其他方式配置，可选择外置变量TG_TOKEN
const TELEGRAM_CHAT_ID = "";          // 在此填写Telegram Chat ID，或留空使用其他方式配置，可选择外置变量TG_ID

// LOGO配置
const LOGO_IMAGE_URL = "https://cdn.jsdelivr.net/gh/kamanfaiz/CF-Server-AutoCheck@main/images/logo.svg"; // LOGO图片链接

// 背景图配置
const DESKTOP_BACKGROUND = "https://cdn.jsdelivr.net/gh/kamanfaiz/CF-Server-AutoCheck@main/images/background/stream.webp"; // 桌面端背景图链接
const MOBILE_BACKGROUND = "https://cdn.jsdelivr.net/gh/kamanfaiz/CF-Server-AutoCheck@main/images/background/cloud.webp"; // 移动端背景图链接
const DARK_MODE_OVERLAY_OPACITY = 0.35; // 深色模式下背景图覆盖层透明度 (0-1)，用于确保文字可读性

// ==========================================
// 2. 工具函数
// ==========================================

// 移除字符串中的emoji表情符号，只保留纯文本用于比较
function removeEmojis(str) {
  if (!str) return '';
  return str.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
}

// 解析cookies
function parseCookies(cookieHeader) {
    const cookies = {};
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            if (name && value) {
                cookies[name] = decodeURIComponent(value);
            }
        });
    }
    return cookies;
}

// 生成认证token（基于密码的固定token，添加时间戳用于过期验证）
async function generateToken(password, timestamp = null) {
    // 统一使用秒级时间戳，确保与验证逻辑一致
    const ts = timestamp || Math.floor(Date.now() / 1000);
    const message = `${password}:${ts}`;
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hashHex}:${ts}`;
}

// ==========================================
// 3. 主入口点 (Worker Main Entry)
// ==========================================

export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      
      // 检查KV绑定状态 - 在所有其他逻辑之前
      const kvBindingStatus = await checkKVBinding(env);
      
      // 处理引导页面相关请求
      if (url.pathname === '/setup') {
        return new Response(getSetupGuideHTML(), {
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
          },
        });
      }
      
      // 处理配置检测API
      if (url.pathname === '/api/check-setup') {
        return await checkSetupStatus(env);
      }
      
      // 如果KV未正确绑定，重定向到引导页面
      if (!kvBindingStatus.isValid && url.pathname !== '/setup') {
        return Response.redirect(url.origin + '/setup', 302);
      }
      
      // 处理API请求
      if (url.pathname.startsWith('/api/')) {
        return handleAPI(request, env);
      }
      
      // 处理登录请求
      if (url.pathname === '/login' && request.method === 'POST') {
        return handleLogin(request, env);
      }
      
      // 处理登出请求
      if (url.pathname === '/logout') {
        return handleLogout(request);
      }
      
      // 检查是否需要登录
      const authRequired = await isAuthRequired(env);
      if (authRequired) {
        const authResult = await checkAuth(request, env);
        const isAuthenticated = authResult.isAuthenticated;
        
        // 如果是dashboard路径且未认证，重定向到登录页
        if (url.pathname === '/dashboard' && !isAuthenticated) {
          return Response.redirect(url.origin + '/', 302);
        }
        
        // 如果是根路径且已认证，重定向到dashboard
        if (url.pathname === '/' && isAuthenticated) {
          return Response.redirect(url.origin + '/dashboard', 302);
        }
        
        // 如果是根路径且未认证，显示登录页
        if (url.pathname === '/' && !isAuthenticated) {
          const config = await getFullConfig(env);
          return new Response(getLoginHTML(config), {
            headers: {
              'Content-Type': 'text/html;charset=UTF-8',
            },
          });
        }
        
        // 如果是dashboard路径且已认证，显示主页面
        if (url.pathname === '/dashboard' && isAuthenticated) {
          const config = await getFullConfig(env);
          return new Response(getHTML(config), {
            headers: {
              'Content-Type': 'text/html;charset=UTF-8',
            },
          });
        }
      } else {
        // 如果未启用认证，直接显示主页面（保持向后兼容）
        if (url.pathname === '/' || url.pathname === '/dashboard') {
          const config = await getFullConfig(env);
          return new Response(getHTML(config), {
            headers: {
              'Content-Type': 'text/html;charset=UTF-8',
            },
          });
        }
      }
      
      // 默认404
      return new Response('Not Found', { status: 404 });
    },
  
    // 处理定时任务
    async scheduled(event, env, ctx) {
      try {
        await checkAndNotifyExpiredVPS(env);
      } catch (error) {
        console.error('Scheduled task error:', error.message);
      }
    },
  };

// ==========================================
// 4. API处理函数
// ==========================================

  // API处理函数
  async function handleAPI(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace('/api', '');
    
    try {
      switch (request.method) {
        case 'GET':
          if (path === '/servers') {
            return await getServers(env);
          } else if (path === '/stats') {
            return await getStats(env);
          } else if (path === '/categories') {
            return await getCategories(env);
          } else if (path === '/settings') {
            return await getSettings(env);
          } else if (path === '/check-setup') {
            return await checkSetupStatus(env);
          }
          break;
          
        case 'POST':
          if (path === '/servers') {
            return await addServer(request, env);
          } else if (path === '/categories') {
            return await addCategory(request, env);
          } else if (path === '/categories/reorder') {
            return await reorderCategories(request, env);
          } else if (path === '/cleanup-servers') {
            return await cleanupServers(request, env);
          } else if (path === '/settings') {
            return await saveSettings(request, env);
          }
          break;
          
        case 'DELETE':
          if (path.startsWith('/servers/')) {
            return await deleteServer(request, env);
          } else if (path.startsWith('/categories/')) {
            return await deleteCategory(request, env);
          }
          break;
          
        case 'PUT':
          if (path.startsWith('/servers/')) {
            return await updateServer(request, env);
          } else if (path.startsWith('/categories/')) {
            return await updateCategory(request, env);
          }
          break;

      }
      
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 获取服务器列表
  async function getServers(env) {
    try {
      const data = await env.SERVER_MONITOR?.get('servers');
      const servers = data ? JSON.parse(data) : [];
      return new Response(JSON.stringify(servers), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to get servers' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 获取统计信息
  async function getStats(env) {
    try {
      const data = await env.SERVER_MONITOR?.get('servers');
      const servers = data ? JSON.parse(data) : [];
      
      const today = new Date();
      let onlineServers = 0;
      let offlineServers = 0;
      let expiringSoon = 0;
      
      servers.forEach(server => {
        if (server.expireDate) {
          const expireDate = new Date(server.expireDate);
          const daysLeft = Math.ceil((expireDate - today) / (1000 * 60 * 60 * 24));
          
          if (daysLeft < 0) {
            // 已过期
            offlineServers++;
          } else {
            // 从续期周期字段计算天数
            let cycleDays = 365; // 默认1年
            if (server.renewalPeriod) {
              const match = server.renewalPeriod.match(/(\d+)(天|个月|月|年)/);
              if (match) {
                const number = parseInt(match[1]);
                const unit = match[2];
                switch (unit) {
                  case '天':
                    cycleDays = number;
                    break;
                  case '月':
                  case '个月':
                    cycleDays = number * 30;
                    break;
                  case '年':
                    cycleDays = number * 365;
                    break;
                }
              }
            }
            
            // 计算50%的阈值，向下取整
            const halfCycle = Math.floor(cycleDays * 0.5);
            
            if (daysLeft <= halfCycle) {
              // 即将过期（剩余天数 <= 周期天数的50%）
              expiringSoon++;
            } else {
              // 正常运行（剩余天数 > 周期天数的50%）
              onlineServers++;
            }
          }
        } else {
          // 没有到期日期的服务器视为正常运行
          onlineServers++;
        }
      });
      
      const stats = {
        totalServers: servers.length,
        onlineServers,
        offlineServers,
        expiringSoon
      };
      
      return new Response(JSON.stringify(stats), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to get stats' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 添加服务器
  async function addServer(request, env) {
    try {
      const server = await request.json();
      const data = await env.SERVER_MONITOR?.get('servers');
      const servers = data ? JSON.parse(data) : [];
      
      // 检查服务器名称是否已存在（忽略emoji，只比较纯文本）
      const normalizedNewName = removeEmojis(server.name);
      
      // 如果移除emoji后名称为空，拒绝添加
      if (!normalizedNewName) {
        return new Response(JSON.stringify({ 
          error: '服务器名称不能只包含表情符号，请添加文字内容',
          code: 'EMPTY_NAME'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const existingServer = servers.find(s => {
        const normalizedExistingName = removeEmojis(s.name);
        return normalizedExistingName === normalizedNewName;
      });
      
      if (existingServer) {
        return new Response(JSON.stringify({ 
          error: `服务器名称已存在，与"${existingServer.name}"冲突，请使用不同的名称`,
          code: 'DUPLICATE_NAME'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      server.id = Date.now().toString();
      server.createdAt = new Date().toISOString();
      servers.push(server);
      
      await env.SERVER_MONITOR?.put('servers', JSON.stringify(servers));
      
      return new Response(JSON.stringify(server), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to add server' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 删除服务器
  async function deleteServer(request, env) {
    try {
      const url = new URL(request.url);
      const serverId = url.pathname.split('/').pop();
      
      const data = await env.SERVER_MONITOR?.get('servers');
      const servers = data ? JSON.parse(data) : [];
      
      const filteredServers = servers.filter(s => s.id !== serverId);
      await env.SERVER_MONITOR?.put('servers', JSON.stringify(filteredServers));
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to delete server' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 更新服务器
  async function updateServer(request, env) {
    try {
      const url = new URL(request.url);
      const serverId = url.pathname.split('/').pop();
      const updatedServerData = await request.json();
      
      const data = await env.SERVER_MONITOR?.get('servers');
      const servers = data ? JSON.parse(data) : [];
      
      const serverIndex = servers.findIndex(s => s.id === serverId);
      if (serverIndex === -1) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 更新服务器信息
      servers[serverIndex] = { ...servers[serverIndex], ...updatedServerData };
      
      await env.SERVER_MONITOR?.put('servers', JSON.stringify(servers));
      
      return new Response(JSON.stringify({ success: true, server: servers[serverIndex] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to update server' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 获取分类列表
  async function getCategories(env) {
    try {
      const data = await env.SERVER_MONITOR?.get('categories');
      const categories = data ? JSON.parse(data) : [];
      return new Response(JSON.stringify(categories), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to get categories' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 添加分类
  async function addCategory(request, env) {
    try {
      const category = await request.json();
      const data = await env.SERVER_MONITOR?.get('categories');
      const categories = data ? JSON.parse(data) : [];
      
      category.id = Date.now().toString();
      category.createdAt = new Date().toISOString();
      categories.push(category);
      
      await env.SERVER_MONITOR?.put('categories', JSON.stringify(categories));
      
      return new Response(JSON.stringify(category), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to add category' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 更新分类
  async function updateCategory(request, env) {
    try {
      const url = new URL(request.url);
      const categoryId = url.pathname.split('/').pop();
      const updatedCategoryData = await request.json();
      
      const data = await env.SERVER_MONITOR?.get('categories');
      const categories = data ? JSON.parse(data) : [];
      
      const categoryIndex = categories.findIndex(c => c.id === categoryId);
      if (categoryIndex === -1) {
        return new Response(JSON.stringify({ error: 'Category not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 更新分类信息
      categories[categoryIndex] = { 
        ...categories[categoryIndex], 
        ...updatedCategoryData,
        updatedAt: new Date().toISOString()
      };
      
      await env.SERVER_MONITOR?.put('categories', JSON.stringify(categories));
      
      return new Response(JSON.stringify({ success: true, category: categories[categoryIndex] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to update category' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 删除分类
  async function deleteCategory(request, env) {
    try {
      const url = new URL(request.url);
      const categoryId = url.pathname.split('/').pop();
      
      // 获取分类数据
      const categoryData = await env.SERVER_MONITOR?.get('categories');
      const categories = categoryData ? JSON.parse(categoryData) : [];
      
      // 获取服务器数据
      const serverData = await env.SERVER_MONITOR?.get('servers');
      const servers = serverData ? JSON.parse(serverData) : [];
      
      // 将该分类下的所有服务器移动到默认分类（设置categoryId为空字符串）
      const updatedServers = servers.map(server => {
        if (server.categoryId === categoryId) {
          return { ...server, categoryId: '' };
        }
        return server;
      });
      
      // 删除分类
      const filteredCategories = categories.filter(c => c.id !== categoryId);
      
      // 保存更新后的数据
      await env.SERVER_MONITOR?.put('categories', JSON.stringify(filteredCategories));
      await env.SERVER_MONITOR?.put('servers', JSON.stringify(updatedServers));
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to delete category' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 重新排序分类
  async function reorderCategories(request, env) {
    try {
      const { categories: newOrder } = await request.json();
      
      // 获取现有分类数据
      const categoryData = await env.SERVER_MONITOR?.get('categories');
      const categories = categoryData ? JSON.parse(categoryData) : [];
      
      // 更新分类的sortOrder
      const updatedCategories = categories.map(category => {
        const newOrderItem = newOrder.find(item => item.id === category.id);
        if (newOrderItem) {
          return { ...category, sortOrder: newOrderItem.sortOrder };
        }
        return category;
      });
      
      // 按sortOrder排序
      updatedCategories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      
      // 保存到存储
      await env.SERVER_MONITOR?.put('categories', JSON.stringify(updatedCategories));
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 清理孤儿服务器
  async function cleanupServers(request, env) {
    try {
      const { servers } = await request.json();
      
      if (!Array.isArray(servers)) {
        return new Response(JSON.stringify({ error: 'Invalid servers data' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await env.SERVER_MONITOR?.put('servers', JSON.stringify(servers));
      
      return new Response(JSON.stringify({ success: true, message: 'Servers cleaned up successfully' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to cleanup servers' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 获取设置
  async function getSettings(env) {
    try {
      // 始终检查外置配置变化，确保配置同步
      const needsForceSync = await checkAndStoreExternalConfigState(env);
      const config = await getFullConfig(env, needsForceSync);
      // 使用同步后的设置，而不是直接从KV读取
      const settings = {
        telegram: {
          botToken: config.telegram.configSource.hasExternal ? config.telegram.botToken : (config.telegram.enabled ? config.telegram.botToken : ''),
          chatId: config.telegram.configSource.hasExternal ? config.telegram.chatId : (config.telegram.enabled ? config.telegram.chatId : ''),
          enabled: config.telegram.enabled
        },
        auth: {
          enabled: config.auth.enabled,
          password: config.auth.configSource.hasExternal ? config.auth.password : (config.auth.password || '')
        },
        globalNotifyDays: config.globalNotifyDays,
        siteTitle: config.siteTitle,
        welcomeMessage: config.welcomeMessage,
        nezhaMonitorUrl: config.nezhaMonitorUrl,
        customLogoUrl: config.customLogoUrl,
        customDesktopBackgroundUrl: config.customDesktopBackgroundUrl,
        customMobileBackgroundUrl: config.customMobileBackgroundUrl
      };

      // 添加配置来源信息
      settings.telegram.configSource = config.telegram.configSource;
      settings.auth.configSource = config.auth.configSource;

      return new Response(JSON.stringify(settings), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to get settings' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 保存设置
  async function saveSettings(request, env) {
    try {
      const settings = await request.json();
      const externalTelegramConfig = hasExternalTelegramConfig(env);
      const externalAuthConfig = hasExternalAuthConfig(env);
      
      // 如果存在外置配置，自动启用相应功能
      if (externalTelegramConfig.hasExternal) {
        settings.telegram.enabled = true;
      }
      
      if (externalAuthConfig.hasExternal) {
        settings.auth.enabled = true;
      }
      
      // 验证Telegram配置：如果没有外置配置且启用了Telegram通知，则必须填写完整配置
      if (!externalTelegramConfig.hasExternal && settings.telegram && settings.telegram.enabled) {
        if (!settings.telegram.botToken || !settings.telegram.chatId) {
          return new Response(JSON.stringify({ error: 'Telegram Bot Token 和 Chat ID 必须同时填写' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } else if (!externalTelegramConfig.hasExternal && settings.telegram && (settings.telegram.botToken || settings.telegram.chatId)) {
        // 没有外置配置且部分填写，返回错误
        return new Response(JSON.stringify({ error: 'Telegram Bot Token 和 Chat ID 必须同时填写或同时留空' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 验证登录认证配置：如果没有外置配置且启用了登录验证，则必须设置密码
      if (!externalAuthConfig.hasExternal && settings.auth && settings.auth.enabled) {
        if (!settings.auth.password || settings.auth.password.trim() === '') {
          return new Response(JSON.stringify({ error: '启用登录验证后，必须设置登录密码' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        if (settings.auth.password.length < 4) {
          return new Response(JSON.stringify({ error: '登录密码长度不能少于4位' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      await env.SERVER_MONITOR?.put('settings', JSON.stringify(settings));
      
      return new Response(JSON.stringify({ success: true, message: 'Settings saved successfully' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to save settings' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }


// ==========================================
// 5. 通知功能函数
// ==========================================

    // 检查VPS到期状态并发送通知
  async function checkAndNotifyExpiredVPS(env) {
    try {
      if (!env.SERVER_MONITOR) {
        console.error('SERVER_MONITOR KV namespace is not bound');
        return;
      }

      const data = await env.SERVER_MONITOR.get('servers');
      if (!data) return;
      
      // 获取全局设置
      const config = await getFullConfig(env);
      const globalNotifyDays = config.globalNotifyDays || 14;
  
      const servers = JSON.parse(data);
      const today = new Date();
  
      // 分类收集需要通知的服务器
      const expiredServers = [];
      const warningServers = [];
  
      for (const server of servers) {
        if (!server.expireDate) continue;
  
        const expireDate = new Date(server.expireDate);
        const daysLeft = Math.ceil((expireDate - today) / (1000 * 60 * 60 * 24));
        // 优先使用服务器单独设置的通知天数，如果没有则使用全局设置
        const notifyDays = parseInt(server.notifyDays) || globalNotifyDays;
  
        if (daysLeft < 0) {
          expiredServers.push({ server, daysLeft });
        } else if (daysLeft <= notifyDays) {
          warningServers.push({ server, daysLeft });
        }
      }
  
      // 发送合并的通知消息
      if (expiredServers.length > 0 || warningServers.length > 0) {
        await sendBatchTelegramNotification(expiredServers, warningServers, env);
      }
    } catch (error) {
      console.error('Check expired VPS error:', error);
    }
  }
  
  // 发送批量Telegram通知
  async function sendBatchTelegramNotification(expiredServers, warningServers, env) {
    try {
      const config = await getFullConfig(env);
      const { botToken, chatId, enabled } = config.telegram;
      
      // 检查是否启用Telegram通知且配置完整
      if (!enabled || !botToken || !chatId) return;

      let message = '🔔 VPS服务器到期监控报告\n\n';
      message += `📅 检查时间: ${new Date().toLocaleString('zh-CN')}\n\n`;

      // 添加已过期服务器信息
      if (expiredServers.length > 0) {
        message += `❌ 已过期服务器 (${expiredServers.length}台):\n`;
        message += '━━━━━━━━━━━━━━━━\n';
        
        expiredServers.forEach(({ server, daysLeft }) => {
          message += `🔸 ${server.name}\n`;
          message += `   已过期: ${Math.abs(daysLeft)} 天\n`;
          message += `   到期日期: ${server.expireDate}\n`;
          message += `   IP地址: ${server.ip || '未知'}\n`;
          message += `   服务商: ${server.provider || '未知'}\n`;
          if (server.renewalLink && server.renewalLink.trim() !== '') {
            message += `   续期链接: ${server.renewalLink}\n`;
          } else {
            message += `   续期链接: 未设置\n`;
          }
          message += `\n`;
        });
      }

      // 添加即将到期服务器信息
      if (warningServers.length > 0) {
        message += `⚠️ 即将到期服务器 (${warningServers.length}台):\n`;
        message += '━━━━━━━━━━━━━━━━\n';
        
        warningServers.forEach(({ server, daysLeft }) => {
          message += `🔸 ${server.name}\n`;
          message += `   剩余天数: ${daysLeft} 天\n`;
          message += `   到期日期: ${server.expireDate}\n`;
          message += `   IP地址: ${server.ip || '未知'}\n`;
          message += `   服务商: ${server.provider || '未知'}\n`;
          if (server.renewalLink && server.renewalLink.trim() !== '') {
            message += `   续期链接: ${server.renewalLink}\n`;
          } else {
            message += `   续期链接: 未设置\n`;
          }
          message += `\n`;
        });
      }

      message += '━━━━━━━━━━━━━━━━\n';
      message += '💡 请及时处理相关服务器的续费事宜';

      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
    } catch (error) {
      console.error('Send batch telegram notification error:', error);
    }
  }

  // 发送单个服务器Telegram通知（用于测试功能）
  async function sendTelegramNotification(server, daysLeft, type, env) {
    try {
      const config = await getFullConfig(env);
      const { botToken, chatId, enabled } = config.telegram;
      
      // 检查是否启用Telegram通知且配置完整
      if (!enabled || !botToken || !chatId) return;
  
      let message = '';
      const status = type === 'expired' ? '❌ 已过期' : '⚠️ 即将到期';
      
      if (type === 'expired') {
        message = `🚨 服务器到期提醒\n\n` +
                  `服务器: ${server.name}\n` +
                  `状态: ${status}\n` +
                  `已过期: ${Math.abs(daysLeft)} 天\n` +
                  `到期日期: ${server.expireDate}\n` +
                  `IP地址: ${server.ip || '未知'}\n` +
                  `服务商: ${server.provider || '未知'}\n` +
                  `续期链接: ${server.renewalLink && server.renewalLink.trim() !== '' ? server.renewalLink : '未设置'}`;
      } else {
        message = `⚠️ 服务器到期提醒\n\n` +
                  `服务器: ${server.name}\n` +
                  `状态: ${status}\n` +
                  `剩余天数: ${daysLeft} 天\n` +
                  `到期日期: ${server.expireDate}\n` +
                  `IP地址: ${server.ip || '未知'}\n` +
                  `服务商: ${server.provider || '未知'}\n` +
                  `续期链接: ${server.renewalLink && server.renewalLink.trim() !== '' ? server.renewalLink : '未设置'}`;
      }
  
      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
    } catch (error) {
      console.error('Send telegram notification error:', error);
    }
  }

// ==========================================
// 6. HTML生成函数
// ==========================================

  // 主页面HTML
  function getHTML(settings = {}) {
    // 获取自定义设置，如果没有则使用默认值
    const siteTitle = (settings.siteTitle && settings.siteTitle.trim() !== '') ? settings.siteTitle : '服务器到期监控';
    const welcomeMessage = (settings.welcomeMessage && settings.welcomeMessage.trim() !== '') ? settings.welcomeMessage : 'Hello!';
    // 获取自定义Logo URL，如果没有则使用默认值
    const logoUrl = (settings.customLogoUrl && settings.customLogoUrl.trim() !== '') ? settings.customLogoUrl : LOGO_IMAGE_URL;
    // 根据Logo格式确定CSS类
    const logoClass = logoUrl.toLowerCase().includes('.svg') || logoUrl.toLowerCase().includes('format=svg') ? 'logo-image svg-logo' : 'logo-image raster-logo';
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

      <title>${siteTitle} - 服务器监控面板</title>
      <!-- Favicon -->
      <link rel="icon" type="image/svg+xml" href="https://cdn.jsdelivr.net/gh/kamanfaiz/CF-Server-AutoCheck@main/images/logo.svg">
      <!-- 阿里巴巴矢量图标库 -->
              <link rel="stylesheet" href="${ICONFONT_CSS_URL}">
        <script src="${ICONFONT_JS_URL}"></script>
      <style>
          /* 全局颜色变量定义 - 浅色模式 */
          ${getColorVariables()}

          /* iconfont 基础样式 */
          .iconfont {
              font-family: "iconfont" !important;
              font-size: 16px;
              font-style: normal;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
          }
          
          * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
          }
          
          body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: var(--bg-light);
              color: var(--text-primary);
              line-height: 1.6;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              position: relative;
              /* 移动端优化 */
              -webkit-overflow-scrolling: touch;
          }
          
          /* 移动端背景图优化 */
          @media (max-width: 768px) {
              body {
                  min-height: 100vh;
              }
              
              #fixed-bg-container {
                  position: fixed !important;
                  width: 100vw !important;
                  height: 100vh !important;
                  /* 移动端特殊处理：确保背景图固定为视口大小 */
                  min-height: 100vh;
                  background-attachment: scroll !important;
              }
          }
          

          
          /* 确保所有内容显示在背景覆盖层之上 */
          .navbar, .main-container, .modal, .notification {
              position: relative;
          }
          
          /* 顶部导航栏 - BLEACH风格 */
          .navbar {
              background: var(--navbar-bg);
              color: var(--text-primary);
              padding: 0;
              position: static;
          }
          
          /* 桌面端导航栏优化 */
          @media (min-width: 769px) {
              .navbar {
                  min-height: 60px;
              }
              
              .navbar-content {
                  flex-wrap: nowrap; /* 防止换行 */
              }
              
              .nav-actions {
                  min-width: auto;
                  flex-wrap: nowrap; /* 防止按钮换行 */
              }
              
              .nav-actions .bg-toggle-btn {
                  flex-shrink: 0; /* 防止按钮被压缩 */
              }
          }
          
          .navbar-content {
              max-width: 1400px;
              margin: 0 auto;
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 0 24px;
              height: 60px;
              overflow: visible; /* 确保内容不被裁剪 */
          }
          
          .logo {
              display: flex;
              align-items: center;
              gap: 12px;
              font-size: 20px;
              font-weight: 700;
              letter-spacing: 1px;
          }
          
          .logo-image {
              width: 26px;
              height: 26px;
              vertical-align: middle;
              transition: filter 0.3s ease, opacity 0.3s ease;
          }
          
          /* SVG Logo - 使用滤镜适配主题 */
          .logo-image.svg-logo {
              filter: brightness(0) saturate(100%) invert(var(--logo-invert)) sepia(100%) saturate(var(--logo-saturate)) hue-rotate(var(--logo-hue)) brightness(var(--logo-brightness)) contrast(var(--logo-contrast));
          }
          
          /* PNG/JPG/WebP Logo - 保持原始颜色 */
          .logo-image.raster-logo {
              filter: none;
          }
          

          
          .nav-actions {
              display: flex;
              align-items: center;
              gap: 8px;  /* 顶部logo栏按钮间距，稍微减小以适应更多按钮 */
              flex-shrink: 0; /* 防止按钮压缩 */
              white-space: nowrap; /* 防止换行 */
          }
          
          .nav-button {
              background: none;
              border: none;
              color: var(--text-primary);
              cursor: pointer;
              padding: 8px 16px;
              border-radius: 6px;
              transition: all 0.2s;
              font-size: 14px;
              display: inline-flex;
              align-items: center;
              gap: 6px;
          }
          
          .nav-button:hover {
              background: var(--hover-bg);
              color: var(--primary-color);
          }
          
          .nav-button.primary {
              background: var(--primary-color);
              color: white;
          }
          
          .nav-button.primary:hover {
              background: var(--primary-dark);
          }

          ${getThemeToggleCSS()}
          
          /* 主内容区 */
          .main-content {
              flex: 1;
          }
          
          .container {
              max-width: 1400px;
              margin: 0 auto;
              padding: 24px;
          }
          
          /* Overview区域 */
          .overview-section {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              margin-bottom: 32px;
          }
          
          .overview-left {
              flex: 1;
          }
          
          .overview-title {
              display: flex;
              align-items: center;
              gap: 8px;
              font-size: 24px;
              font-weight: 600;
              margin-bottom: 8px;
              color: var(--text-primary);
          }
          

          
          .overview-time {
              font-size: 14px;
              margin-bottom: 24px;
          }
          
          .overview-time::before {
              content: "当前时间  ";
              color: var(--text-primary);
              opacity: 0.75;
          }
          
          /* 统计卡片 - 优化布局避免3+1不对称情况 */
          .stats-grid {
              display: grid;
              gap: 20px;
              /* 默认桌面端：1行4个 */
              grid-template-columns: repeat(4, 1fr);
              margin-bottom: 32px;
          }
          
          .stat-card {
              background: var(--bg-primary);
              padding: 20px;
              border-radius: 12px;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
              border: 1px solid var(--border-color);
              transition: all 0.2s;
              cursor: pointer;
          }
          
          .stat-card:hover {
              box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
              transform: translateY(-2px);
          }
          

          
          .stat-card h3 {
              font-size: 16px;
              color: var(--text-primary);
              margin-bottom: 8px;
              font-weight: 500;
              display: flex;
              align-items: center;
              gap: 6px;
          }
          
          .stat-card.total h3 .iconfont { color: var(--total-server-color); }
          .stat-card.online h3 .iconfont { color: var(--success-color); }
          .stat-card.warning h3 .iconfont { color: var(--warning-color); }
          .stat-card.offline h3 .iconfont { color: var(--danger-color); }
          
          .stat-card .value {
              font-size: 32px;
              font-weight: 700;
              margin-bottom: 4px;
              display: flex;
              align-items: center;
              gap: 8px;
          }
          
          .stat-card.total .value { color: var(--total-server-color); }
          .stat-card.online .value { color: var(--success-color); }
          .stat-card.offline .value { color: var(--danger-color); }
          .stat-card.warning .value { color: var(--warning-color); }
          
          /* 总服务器卡片中的状态指示器颜色 */
          .stat-card.total .status-indicator { background: var(--total-server-color); }
          
          .status-indicator {
              width: 8px;
              height: 8px;
              border-radius: 50%;
              display: inline-block;
          }
          
          .status-indicator.online { background: var(--success-color); }
          .status-indicator.offline { background: var(--danger-color); }
          .status-indicator.warning { background: var(--warning-color); }
          
          /* 统计卡片响应式布局 - 避免3+1不对称情况 */
          @media (max-width: 1200px) and (min-width: 769px) {
              /* 中等屏幕：2行2个对称布局 */
              .stats-grid {
                  grid-template-columns: repeat(2, 1fr);
              }
          }
          
          @media (max-width: 768px) {
              /* 移动端：2行2个紧凑布局 */
              .stats-grid {
                  grid-template-columns: repeat(2, 1fr);
                  gap: 15px;
              }
          }
          
          /* 服务器卡片网格 */
          .servers-section {
              margin-bottom: 32px;
          }
          
          .section-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 20px;
          }
          
          .section-title {
              font-size: 18px;
              font-weight: 600;
              color: var(--text-primary);
          }
          
          .section-actions {
              display: flex;
              gap: 12px;
              align-items: center;
          }
          
          /* 排序下拉菜单样式 */
          .sort-dropdown-container {
              position: relative;
              display: inline-block;
          }
          
          .sort-dropdown {
              position: absolute;
              top: 100%;
              left: 0;
              background: var(--bg-primary);
              border: 1px solid var(--border-color);
              border-radius: 8px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
              min-width: 180px;
              z-index: 1000;
              display: none;
              margin-top: 4px;
              padding: 6px 0;
          }
          
          .sort-dropdown.show {
              display: block;
          }
          
          .sort-option {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 8px 16px;
              margin: 2px 8px;
              cursor: pointer;
              font-size: 14px;
              color: var(--text-secondary);
              transition: all 0.2s ease;
              border: none;
              background: transparent;
              border-radius: 6px;
          }
          
          .sort-option:hover {
              background-color: var(--hover-bg);
              color: var(--primary-color);
          }
          
          .sort-option .iconfont {
              font-size: 14px;
              color: var(--primary-color);
              opacity: 0;
              transition: opacity 0.2s;
          }
          
          .sort-option.active {
              background-color: var(--hover-bg);
              color: var(--primary-color);
              font-weight: 500;
          }
          
          .sort-option.active .iconfont {
              opacity: 1;
              color: var(--primary-color);
          }
          
          /* 排序菜单分隔线样式 */
          .sort-divider {
              height: 1px;
              background: var(--border-color);
              margin: 6px 16px;
          }
          
          .servers-grid {
              display: flex;
              flex-direction: column;
              gap: 32px;
          }
          
          /* 分类区域样式 */
          .category-section {
              background: var(--bg-primary);
              border-radius: 12px;
              padding: 24px;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
              border: 1px solid var(--border-color);
          }
          
          .category-header {
              display: flex;
              align-items: center;
              gap: 12px;
              margin-bottom: 20px;
              padding-bottom: 12px;
              border-bottom: 1px solid var(--border-color);
          }
          
          .category-title {
              font-size: 16px;
              font-weight: 600;
              color: var(--text-primary);
              margin: 0;
          }
          
          .category-count {
              background: var(--bg-secondary);
              color: var(--text-secondary);
              padding: 2px 8px;
              border-radius: 12px;
              font-size: 12px;
              font-weight: 500;
          }
          
          .category-title-section {
              display: flex;
              align-items: center;
              gap: 12px;
              flex: 1;
          }
          
          .category-select-all {
              width: 16px;
              height: 16px;
              cursor: pointer;
              accent-color: #3b82f6;
              border-radius: 3px;
          }
          
          .category-actions {
              display: flex;
              gap: 12px;
              margin-left: auto;
          }
          
          .category-servers {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
              gap: 20px;
          }
          
          .empty-category {
              background: var(--bg-secondary);
              border: 2px dashed var(--border-color);
              border-radius: 8px;
              margin: 8px 0;
          }
          

          
          /* 监控卡片样式 - 参考old-version设计 */
          .server-card {
              background: var(--bg-primary);
              border: 1px solid var(--border-light);
              border-radius: 12px;
              padding: 16px 0;
              transition: box-shadow 0.2s ease;
              box-sizing: border-box;
              overflow: hidden;
              width: 100%;
              max-width: 100%;
          }
          
          .server-card:hover {
              box-shadow: 0 4px 12px var(--selected-border);
          }
          
          .server-card.selected {
              border: 2px solid var(--primary-color);
              box-shadow: 0 4px 16px var(--selected-border);
              background: var(--selected-bg);
          }
          
          /* 卡片头部 - 简化自适应设计 */
          .monitor-card-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin: -4px 20px 10px 20px; /* 上边距为0，与底部标签外框边距对称 */
              padding-bottom: 8px;
              border-bottom: 1px solid var(--border-light);
              overflow: hidden;
              flex-shrink: 0;
          }
          
          .monitor-title-section {
              display: flex;
              align-items: center;
              gap: 8px;
              flex: 1;
              min-width: 0;
          }
          
          .server-name-container {
              display: flex;
              align-items: flex-start;
              gap: 6px;
              flex: 1;
              min-width: 0;
              overflow: hidden;
              padding-top: 2px;
          }
          
          .monitor-card-checkbox {
              width: 16px;
              height: 16px;
              cursor: pointer;
              accent-color: var(--primary-color);
              border-radius: 3px;
          }
          
          .monitor-vps-title {
              font-size: 17px;
              font-weight: 600;
              color: var(--text-primary);
              margin: 0;
              cursor: pointer;
              line-height: 1.5;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              transition: color 0.2s ease;
              flex: 1;
              min-width: 0;
              max-width: calc(100% - 30px);
              height: auto;
              padding: 2px 0;
          }
          
          .monitor-vps-title:hover {
              color: var(--primary-color);
              text-decoration: underline;
          }
          
          .server-name-copy-btn {
              font-size: 14px;
              color: var(--text-secondary);
              cursor: pointer;
              transition: all 0.2s;
              padding: 4px 2px;
              border-radius: 3px;
              flex-shrink: 0;
              align-self: flex-start;
              margin-top: 2px;
          }
          
          .server-name-copy-btn:hover {
              color: var(--primary-color);
              background: var(--hover-bg);
          }
          
          /* 卡片内容 - 简化自适应设计 */
          .monitor-card-content {
              display: flex;
              align-items: flex-end;
              margin: 0 20px 12px 20px; /* 统一使用20px边距 */
          }
          
          .monitor-info-section {
              flex: 1; /* 自适应伸缩的红框区域 */
              display: flex;
              flex-direction: column;
              gap: 6px;
              margin-right: 16px; /* 与右侧区域的间距 */
              min-width: 0; /* 允许内容压缩 */
          }
          
          .monitor-info-item {
              font-size: 12px;
              color: var(--text-primary);
              line-height: 1.3;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
          }
          
          .monitor-right-section {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 4px;
              width: 90px; /* 固定宽度而不是min-width */
              flex-shrink: 0; /* 防止被压缩 */
          }
          
          .monitor-days-display {
              text-align: center;
              margin: 0;
          }
          
          .monitor-days-number {
              font-size: 36px;
              font-weight: 700;
              line-height: 0.8;  // 卡片剩余天数行高设定，单位是倍率，1就是字体的高度
              margin-bottom: 2px;
          }
          
          .monitor-days-number.normal {
              color: var(--success-color);
          }
          
          .monitor-days-number.warning {
              color: var(--warning-color);
          }
          
          .monitor-days-number.expired {
              color: var(--danger-color);
          }
          
          .monitor-days-label {
              font-size: 12px;
              color: var(--text-secondary);
              font-weight: 500;
              margin: 0;
              line-height: 1.2;
          }
          
          .monitor-notification-info {
              text-align: center;
              margin: -6px 0 6px 0;
          }
          
          .notification-days-label {
              font-size: 10px;
              color: var(--primary-color);
              background: var(--hover-bg);
              padding: 3px 6px;
              border-radius: 10px;
              font-weight: 500;
              white-space: nowrap;
              margin: 0;
              line-height: 1.2;
          }
          
          .monitor-actions {
              display: flex;
              gap: 6px;
              margin: 0;
          }
          
          .monitor-action-btn {
              width: 28px;
              height: 28px;
              border: 1px solid var(--border-light);
              border-radius: 5px;
              background: var(--bg-primary);
              color: var(--text-secondary);
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: center;
              transition: all 0.2s;
              font-size: 12px;
          }
          
          .monitor-action-btn:hover {
              border-color: var(--primary-color);
              color: var(--primary-color);
              transform: translateY(-1px);
          }
          
          .monitor-action-btn:disabled {
              opacity: 0.5;
              cursor: not-allowed;
          }
          
          /* 卡片底部 - 简化自适应设计 */
          .monitor-card-footer {
              display: flex;
              justify-content: space-between;
              align-items: flex-end;
              margin: 12px 20px 0 20px; /* 统一使用20px边距 */
              padding-top: 10px;
              border-top: 1px solid var(--border-muted);
          }
          
          .monitor-team-section {
              display: flex;
              flex-direction: column;
              gap: 4px;
          }
          
          .monitor-team-label {
              font-size: 10px;
              color: var(--text-secondary);
              font-weight: 500;
          }
          
          .ip-label-container {
              display: flex;
              align-items: center;
              gap: 4px;
          }
          
          .monitor-ip-address {
              font-size: 12px;
              color: var(--text-primary);
              font-weight: 500;
              font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Courier New', monospace;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              max-width: 120px;
          }
          
          .ip-copy-btn {
              font-size: 10px;
              color: var(--text-secondary);
              cursor: pointer;
              transition: all 0.2s;
              padding: 2px;
              border-radius: 3px;
          }
          
          .ip-copy-btn:hover {
              color: var(--primary-color);
              background: var(--hover-bg);
          }
          
          .monitor-server-type {
              display: flex;
              gap: 6px;
          }
          
          .server-type-badge {
              padding: 3px 6px;
              border-radius: 4px;
              font-size: 10px;
              font-weight: 500;
              border: 1px solid;
              display: flex;
              align-items: center;
              gap: 3px;
              white-space: nowrap;
          }
          
          .server-type-badge .iconfont {
              font-size: 10px;
              line-height: 1;
          }
          
          .btn .iconfont {
              font-size: 14px;
              line-height: 1;
          }
          
          .action-btn .iconfont {
              font-size: 12px;
              line-height: 1;
          }
          
          .nav-button .iconfont {
              font-size: 14px;
              line-height: 1;
          }
          
          .category-title .iconfont {
              font-size: 16px;
              line-height: 1;
          }
          
          /* Footer样式 */
          .footer {
              background: var(--footer-bg);
              color: var(--text-primary);
              padding: 8px 0;
              margin-top: auto;
          }
          
          .footer-content {
              max-width: 1400px;
              margin: 0 auto;
              text-align: center;
              padding: 0 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              gap: 15px;
              flex-wrap: wrap;
          }
          
          .footer-text {
              font-size: 14px;
          }
          
          .footer-link {
              color: var(--text-primary);
              text-decoration: none;
              font-size: 14px;
              transition: color 0.2s ease;
              display: flex;
              align-items: center;
              gap: 5px;
          }
          
          .footer-link:hover {
              color: var(--primary-color);
          }
          
          .footer-divider {
              color: var(--text-primary);
          }
          
          .footer-link .iconfont {
              font-size: 14px;
              line-height: 1;
          }
          
          .action-btn {
              background: none;
              border: 1px solid var(--border-color);
              color: var(--text-secondary);
              cursor: pointer;
              padding: 6px 12px;
              border-radius: 6px;
              font-size: 12px;
              font-weight: 500;
              transition: all 0.2s;
              display: flex;
              align-items: center;
              justify-content: center;
              white-space: nowrap;
              gap: 4px;
          }
          
          .action-btn:hover {
              border-color: var(--primary-color);
              color: var(--primary-color);
              transform: translateY(-1px);
          }
          
          .action-btn.primary {
              border-color: var(--primary-color);
              color: var(--primary-color);
              background: var(--hover-bg);
          }
          
          .action-btn.primary:hover {
              background: var(--primary-color);
              color: white;
          }
          
          .action-btn.danger {
              border-color: var(--danger-color);
              color: var(--danger-color);
              background: rgba(220, 53, 69, 0.1);
          }
          
          .action-btn.danger:hover {
              background: var(--danger-color);
              color: white;
          }
          
          .action-btn.secondary {
              border-color: var(--text-secondary);
              color: var(--text-secondary);
              background: rgba(149, 165, 166, 0.1);
          }
          
          .action-btn.secondary:hover {
              background: var(--text-secondary);
              color: white;
          }
          

          
          /* 续期链接样式 */
          .renewal-link {
              font-size: 12px !important;
              color: var(--primary-color) !important;
              text-decoration: none !important;
              transition: color 0.2s;
          }
          
          .renewal-link:hover {
              color: var(--primary-dark) !important;
              text-decoration: underline !important;
          }
          
          /* 添加服务器表单（模态框风格） */
          .modal {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0, 0, 0, 0.6);
              z-index: 2000;
              justify-content: center;
              align-items: center;
              cursor: not-allowed;
          }
          
          .modal.show {
              display: flex;
          }
          
          .modal-content {
              background: var(--bg-primary);
              border-radius: 12px;
              padding: 24px;
              max-width: 800px;
              width: 95%;
              max-height: 90vh;
              overflow-y: auto;
              overflow-x: hidden;
              cursor: default;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
          }
          
          .modal-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 24px;
          }
          
          .modal-title-section {
              display: flex;
              align-items: center;
              gap: 12px;
          }
          
          .modal-title {
              font-size: 20px;
              font-weight: 600;
              color: var(--text-primary);
          }
          
          .close-btn {
              background: none;
              border: none;
              font-size: 24px;
              cursor: pointer;
              color: var(--text-secondary);
              padding: 4px 8px;
              border-radius: 4px;
              transition: all 0.2s;
          }
          
          .close-btn:hover {
              color: var(--danger-color);
              background: rgba(231, 76, 60, 0.1);
              transform: scale(1.1);
          }
          
          .import-btn-header {
              background: none;
              border: none;
              font-size: 18px;
              cursor: pointer;
              color: #95a5a6;
              padding: 6px;
              border-radius: 4px;
              transition: all 0.2s;
          }
          
          .import-btn-header:hover {
              color: var(--primary-color);
              background: var(--hover-bg);
              transform: scale(1.1);
          }
          
          /* 设置页面专用样式 */
          .settings-modal-content {
              max-width: 800px;
              border-radius: 12px;
          }
          
          .settings-body {
              display: flex;
              flex-direction: column;
              border-radius: 8px;
              overflow: hidden;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          }
          
          /* 顶部标签页导航 */
          .settings-nav {
              display: flex;
              background: var(--bg-secondary);
              border-bottom: 1px solid var(--border-light);
              margin: 0;
              padding: 0;
              border-radius: 8px 8px 0 0;
          }
          
          .settings-nav-item {
              display: flex;
              align-items: center;
              gap: 8px;
              padding: 16px 24px;
              cursor: pointer;
              color: var(--text-secondary);
              transition: all 0.3s ease;
              font-size: 14px;
              font-weight: 500;
              border-bottom: 3px solid transparent;
              background: none;
              border: none;
              border-radius: 0;
              flex: 1;
              justify-content: center;
              text-align: center;
              min-width: 120px;
              position: relative;
              user-select: none;
          }
          
          .settings-nav-item:first-child {
              border-radius: 8px 0 0 0;
          }
          
          .settings-nav-item:last-child {
              border-radius: 0 8px 0 0;
          }
          
          .settings-nav-item:hover {
              background: var(--border-light);
              color: var(--text-primary);
              transform: translateY(-1px);
          }
          
          .settings-nav-item.active {
              background: var(--bg-primary);
              color: var(--primary-color);
              font-weight: 600;
              border-bottom-color: var(--primary-color);
              box-shadow: 0 2px 4px rgba(0, 123, 255, 0.1);
          }
          
          .settings-nav-item.active::after {
              content: '';
              position: absolute;
              bottom: -1px;
              left: 0;
              right: 0;
              height: 3px;
              background: linear-gradient(90deg, var(--primary-color), var(--primary-dark));
              border-radius: 2px 2px 0 0;
          }
          
          .settings-nav-item i {
              font-size: 16px;
          }
          
          .settings-content {
              flex: 1;
              padding: 32px;
              position: relative;
              background: var(--bg-primary);
              border-radius: 0 0 8px 8px;
              box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
          }
          
          .settings-tab {
              display: none;
          }
          
          .settings-tab.active {
              display: block;
          }
          
          .settings-tab-title {
              margin: 0 0 20px 0;
              color: var(--text-primary);
              font-size: 18px;
              font-weight: 600;
              display: flex;
              align-items: center;
              gap: 8px;
          }
          
          .form-notice {
              background: var(--bg-secondary);
              border: 1px solid var(--border-light);
              border-radius: 6px;
              padding: 12px;
              margin-bottom: 20px;
              font-size: 13px;
              color: var(--text-primary);
              line-height: 1.5;
          }
          
          .form-help {
              font-size: 12px;
              color: var(--text-secondary);
              margin-top: 4px;
              line-height: 1.4;
          }
          

          
          /* 表单样式 */
          .form-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 16px 24px;
              margin-bottom: 20px;
          }
          
          .form-group.full-width {
              grid-column: 1 / -1;
          }
          
          .form-group.inline-flex {
              display: flex;
              gap: 12px;
              align-items: flex-end;
          }
          
          .form-group.inline-flex > div {
              flex: 1;
          }
          
          .form-group {
              display: flex;
              flex-direction: column;
          }
          
          .form-group label {
              margin-bottom: 4px;
              font-weight: 500;
              color: var(--text-primary);
              font-size: 13px;
          }
          
          .form-group label .required {
              color: var(--danger-color);
              margin-left: 2px;
          }
          
          .form-group input,
          .form-group select {
              width: 100%;
              padding: 10px 12px;
              border: 1px solid var(--border-color);
              border-radius: 6px;
              font-size: 13px;
              transition: border-color 0.2s;
              background-color: var(--bg-primary);
              color: var(--text-primary);
              box-sizing: border-box;
          }
          
          .form-group input:focus,
          .form-group select:focus {
              outline: none;
              border-color: var(--primary-color);
          }
          
          .form-group input[type="radio"] {
              width: auto;
              cursor: pointer;
              accent-color: var(--primary-color);
          }
          
          .form-group label[style*="cursor: pointer"]:hover {
              opacity: 0.8;
          }
          
          .form-group label[style*="cursor: pointer"] span {
              user-select: none;
          }
          
          .form-group input::placeholder {
              color: var(--text-secondary);
              opacity: 0.7;
          }
          
          /* 输入框验证状态样式 */
          .form-group input.input-error {
              border-color: var(--danger-color);
              background-color: ${DESKTOP_BACKGROUND ? 'rgba(253, 242, 242, 0.8)' : '#fdf2f2'};
          }
          
          .form-group input.input-success {
              border-color: var(--success-color);
              background-color: ${DESKTOP_BACKGROUND ? 'rgba(242, 249, 242, 0.8)' : '#f2f9f2'};
          }
          
          .form-group input.input-error:focus {
              border-color: var(--danger-color);
              box-shadow: 0 0 0 2px rgba(231, 76, 60, 0.2);
          }
          
          .form-group input.input-success:focus {
              border-color: var(--success-color);
              box-shadow: 0 0 0 2px rgba(39, 174, 96, 0.2);
          }
          
          /* 只读日期输入框样式 */
          .form-group input.readonly-date-input {
              cursor: not-allowed;
              opacity: 0.8;
          }
          
          /* 浅色模式下的只读日期输入框背景 */
          .form-group input.readonly-date-input {
              background-color: #f8f9fa;
          }
          
          .form-group input.readonly-date-input.renewal-success {
              background-color: #e8f5e8;
          }
          
          /* 可编辑的续期日期输入框样式 */
          .form-group input.renewal-date-input:not([readonly]) {
              background-color: var(--bg-primary);
              border-color: var(--primary-color);
              cursor: text;
              opacity: 1;
          }
          
          .form-group input.renewal-date-input:not([readonly]):focus {
              border-color: var(--primary-color);
              box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
          }
          
          /* 深色模式下的只读日期输入框样式 */
          [data-theme="dark"] .form-group input.readonly-date-input {
              background-color: var(--bg-secondary);
              color: var(--text-primary);
              border-color: var(--border-color);
          }
          
          [data-theme="dark"] .form-group input.readonly-date-input.renewal-success {
              background-color: rgba(64, 217, 98, 0.1);
              border-color: var(--success-color);
              color: var(--text-primary);
          }
          
          /* 修复苹果设备日期输入框宽度问题 */
          @supports (-webkit-appearance: none) {
              .form-group input[type="date"] {
                  -webkit-appearance: none;
                  -moz-appearance: textfield;
                  width: 100% !important;
                  min-width: 100% !important;
              }
          }
          
          /* iOS设备特殊处理 */
          @media screen and (-webkit-min-device-pixel-ratio: 2) {
              .form-group input[type="date"] {
                  width: 100% !important;
                  max-width: 100% !important;
                  -webkit-appearance: none;
              }
          }
          
          /* 密码输入框包装器样式 */
          .password-input-wrapper {
              position: relative;
              display: flex;
              align-items: center;
          }
          
          .password-input-wrapper input {
              flex: 1;
              padding-right: 40px; /* 为图标留出空间 */
          }
          
          .password-toggle {
              position: absolute;
              right: 12px;
              cursor: pointer;
              color: var(--text-secondary);
              font-size: 16px;
              transition: color 0.2s;
              user-select: none;
              z-index: 1;
          }
          
          .password-toggle:hover {
              color: var(--primary-color);
          }
          
          .provider-container {
              display: flex;
              align-items: center;
          }
          
          .provider-container select,
          .provider-container input {
              flex: 1;
          }
          
          /* 标签颜色选择样式 */
          .color-btn {
              width: 24px;
              height: 24px;
              border: 2px solid var(--bg-primary);
              border-radius: 50%;
              cursor: pointer;
              transition: all 0.2s;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          
          .color-btn:hover {
              transform: scale(1.1);
              box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          }
          
          .color-btn.selected {
              border-color: var(--text-primary);
              transform: scale(1.15);
              box-shadow: 0 0 0 2px var(--primary-color);
          }
          
          /* 续期模态框分组样式 */
          .renewal-section {
              padding: 16px;
              margin-bottom: 20px;
              background: var(--bg-muted);
              border-radius: 8px;
              border: 1px solid var(--border-color);
          }
          
          .renewal-section:last-of-type {
              margin-bottom: 0;
          }
          
          .renewal-section-title {
              display: flex;
              align-items: center;
              gap: 8px;
              margin-bottom: 16px;
              padding-bottom: 12px;
              border-bottom: 2px solid var(--border-color);
              font-size: 14px;
              font-weight: 600;
              color: var(--primary-color);
          }
          
          .renewal-section-title .iconfont {
              font-size: 16px;
          }
          
          /* 续期选项网格布局 */
          .renewal-options-grid {
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 12px 16px;
              margin-top: 8px;
          }
          
          .renewal-option-item {
              display: flex;
              align-items: center;
              cursor: pointer;
              padding: 8px 0;
          }
          
          .renewal-option-item input[type="radio"] {
              margin-right: 8px;
              flex-shrink: 0;
          }
          
          .renewal-option-item span {
              user-select: none;
              font-size: 14px;
          }
          
          /* 续期起始日期标签样式 */
          .renewal-start-label {
              display: block;
              margin-bottom: 4px;
          }
          
          /* 桌面端：单行显示 */
          @media (min-width: 768px) {
              .renewal-options-grid {
                  grid-template-columns: repeat(4, 1fr);
                  gap: 8px;
              }
              
              .renewal-option-item {
                  padding: 0;
              }
          }
          
          .renewal-section .form-group {
              margin-bottom: 0;
          }
          
          .renewal-section .form-group:not(:last-child) {
              margin-bottom: 16px;
          }
          
          .form-actions {
              display: flex;
              gap: 12px;
              justify-content: flex-end;
              padding-top: 16px;
              border-top: 1px solid var(--border-color);
          }
          
          .btn {
              padding: 12px 24px;
              border: none;
              border-radius: 8px;
              cursor: pointer;
              font-size: 14px;
              font-weight: 500;
              transition: all 0.2s;
              display: inline-flex;
              align-items: center;
              gap: 6px;
          }
          
          .btn-primary {
              background: var(--primary-color);
              color: white;
          }
          
          .btn-primary:hover {
              background: var(--primary-dark);
          }
          
          .btn-secondary {
              background: var(--text-secondary);
              color: white;
          }
          
          .btn-secondary:hover {
              background: var(--text-secondary-hover);
              color: white;
              transform: translateY(-1px);
          }
          

          
          /* 空状态 */
          .empty-state {
              text-align: center;
              padding: 60px 20px;
              color: var(--text-secondary);
              background: var(--bg-primary);
              border-radius: 12px;
              border: 1px solid var(--border-color);
          }
          
          .empty-state h3 {
              font-size: 18px;
              margin-bottom: 8px;
              color: var(--text-secondary);
          }
          
          .empty-state p {
              margin-bottom: 24px;
          }
          
          /* 响应式设计 - 桌面端优化 */
          @media (max-width: 1200px) and (min-width: 769px) {
              .category-servers {
                  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                  gap: 16px;
              }
          }

          /* 移动端适配 */
          @media (max-width: 768px) {
              /* 基础布局调整 */
              body {
                  font-size: 14px;
              }

              /* 导航栏移动端适配 - 两行布局 */
              .navbar {
                  padding: 8px 15px;
                  min-height: 80px; /* 增加高度以容纳两行 */
                  position: relative;
              }

              .navbar-content {
                  height: auto;
                  padding: 0;
                  position: relative;
              }

              /* 隐藏第一行的主题切换按钮 */
              .nav-actions .theme-toggle-wrapper {
                  display: none;
              }

              /* 移动端第二行：只包含主题切换按钮 */
              .mobile-navbar-second-row {
                  position: absolute;
                  bottom: 8px;
                  right: 15px;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  z-index: 10;
              }

              /* 第二行的主题切换按钮 */
              .mobile-navbar-second-row .theme-toggle-wrapper {
                  display: flex;
                  align-items: center;
              }



              /* 站点标题移动端优化 */
              .site-title {
                  font-size: 16px;
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  max-width: 120px;
              }

              /* 时间显示移动端优化 */
              .current-time {
                  font-size: 12px;
                  white-space: nowrap;
              }

              /* 按钮组移动端适配 */
              .navbar-right .btn {
                  padding: 6px 10px;
                  font-size: 12px;
                  min-width: auto;
              }

              .navbar-right .btn .iconfont {
                  font-size: 14px;
              }
              
              /* 导航栏操作按钮移动端优化 */
              .nav-actions .bg-toggle-btn {
                  width: 32px;
                  height: 32px;
                  padding: 0;
                  font-size: 14px;
                  border-radius: 6px;
                  display: flex;
                  align-items: center;
                  justify-content: center;
              }

              /* 主内容区移动端优化 - 减少间距 */
              .container {
                  padding: 12px 15px; /* 减少上下间距从24px到12px */
              }

              /* 概览区域移动端优化 */
              .overview-section {
                  margin-bottom: 20px; /* 减少底部间距从32px到20px */
              }

              /* 主要操作按钮移动端适配 - 统一方形按钮样式 */
              .section-actions .btn {
                  width: 40px !important;
                  height: 40px !important;
                  padding: 0 !important;
                  margin: 0 !important;
                  display: flex !important;
                  align-items: center !important;
                  justify-content: center !important;
                  border-radius: 8px !important;
                  font-size: 0 !important;
                  line-height: 40px !important;
                  min-width: 40px !important;
                  max-width: 40px !important;
                  box-sizing: border-box !important;
                  text-align: center !important;
                  position: relative;
              }

              .section-actions .btn .iconfont {
                  font-size: 16px !important;
                  line-height: 16px !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  display: block !important;
                  width: 16px !important;
                  height: 16px !important;
                  text-align: center !important;
                  position: absolute !important;
                  top: 50% !important;
                  left: 50% !important;
                  transform: translate(-50%, -50%) !important;
              }

              /* 排序下拉容器适配 */
              .sort-dropdown-container .btn {
                  width: 40px !important;
                  height: 40px !important;
                  padding: 0 !important;
                  margin: 0 !important;
                  display: flex !important;
                  align-items: center !important;
                  justify-content: center !important;
                  font-size: 0 !important;
                  line-height: 40px !important;
                  box-sizing: border-box !important;
                  text-align: center !important;
                  position: relative;
              }

              .sort-dropdown-container .btn .iconfont {
                  font-size: 16px !important;
                  line-height: 16px !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  display: block !important;
                  width: 16px !important;
                  height: 16px !important;
                  text-align: center !important;
                  position: absolute !important;
                  top: 50% !important;
                  left: 50% !important;
                  transform: translate(-50%, -50%) !important;
              }

              /* 操作按钮容器适配 */
              .section-actions {
                  display: flex;
                  align-items: center;
                  gap: 8px;
                  flex-wrap: nowrap;
              }

              /* 分类操作按钮移动端适配 - 统一方形按钮样式 */
              .action-btn {
                  width: 32px !important;
                  height: 32px !important;
                  padding: 0 !important;
                  margin: 0 !important;
                  align-items: center !important;
                  justify-content: center !important;
                  border-radius: 6px !important;
                  font-size: 0 !important;
                  line-height: 32px !important;
                  min-width: 32px !important;
                  max-width: 32px !important;
                  box-sizing: border-box !important;
                  text-align: center !important;
                  position: relative;
                  border-width: 1px !important;
              }

              /* 只对显示的按钮应用flex布局 */
              .action-btn:not([style*="display: none"]) {
                  display: flex !important;
              }

              /* 确保隐藏的按钮保持隐藏 */
              .action-btn[style*="display: none"] {
                  display: none !important;
              }

              .action-btn .iconfont {
                  font-size: 14px !important;
                  line-height: 14px !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  display: block !important;
                  width: 14px !important;
                  height: 14px !important;
                  text-align: center !important;
                  position: absolute !important;
                  top: 50% !important;
                  left: 50% !important;
                  transform: translate(-50%, -50%) !important;
              }

              /* 分类操作按钮容器适配 */
              .category-actions {
                  display: flex;
                  align-items: center;
                  gap: 6px;
                  flex-wrap: nowrap;
              }

              /* 主要内容区域 */
              .main-content {
                  padding: 0px; /* 移除padding，由container控制 */
                  margin-top: 10px; /* 只保留一个小间距 */
              }

              /* 统计卡片移动端布局 - 2x2网格 */
              .stats-grid {
                  grid-template-columns: 1fr 1fr !important;
                  gap: 12px !important;
                  margin-bottom: 20px !important;
              }

              .stat-card {
                  padding: 15px !important;
                  border-radius: 10px !important;
              }

              .stat-card h3 {
                  font-size: 14px !important;
                  margin-bottom: 6px !important;
                  gap: 4px !important;
              }

              .stat-card h3 .iconfont {
                  font-size: 14px !important;
              }

              .stat-card .value {
                  font-size: 24px !important;
                  margin-bottom: 2px !important;
                  gap: 6px !important;
              }

              .status-indicator {
                  width: 6px !important;
                  height: 6px !important;
              }

              /* 服务器卡片移动端适配 */
              .category-servers {
                  grid-template-columns: 1fr;
                  gap: 12px;
              }

              .server-card {
                  padding: 12px;
                  border-radius: 8px;
              }

              /* 移动端卡片内容布局优化 */
              /* 移动端简化调整：只调整右侧区域以防止按钮被裁切 */
              .monitor-right-section {
                  width: 80px; /* 移动端稍微减小宽度，防止按钮被裁切 */
              }
              
              .monitor-action-btn {
                  width: 22px !important;
                  height: 22px !important;
                  font-size: 11px !important;
                  padding: 0 !important;
              }

              /* 服务器卡片头部 */
              .server-header {
                  flex-wrap: nowrap;
                  gap: 8px;
              }

              .server-info {
                  min-width: 0;
                  flex: 1;
              }

              .server-name {
                  font-size: 14px;
                  line-height: 1.3;
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
              }

              .server-location {
                  font-size: 11px;
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
              }

              /* 监控信息移动端布局 */
              .monitor-section {
                  flex-direction: column;
                  gap: 8px;
              }

              .monitor-left-section {
                  width: 100%;
                  gap: 8px;
              }

              .monitor-right-section {
                  width: auto; /* 改为auto以适应内容 */
                  justify-content: center; /* 居中对齐 */
                  gap: 6px; /* 减少间距 */
                  flex-shrink: 0; /* 防止被压缩 */
                  min-width: 80px; /* 确保最小宽度容纳按钮 */
              }

              /* 移动端按钮组优化 */
              .monitor-actions {
                  display: flex;
                  gap: 4px; /* 减少按钮间距 */
              }

              /* 移动端按钮尺寸优化 */
              .monitor-action-btn {
                  width: 24px !important;
                  height: 24px !important;
                  font-size: 12px !important;
                  padding: 0 !important;
              }

              /* 状态指示器 */
              .status-indicator {
                  width: 8px;
                  height: 8px;
              }

              /* 监控项移动端适配 */
              .monitor-item {
                  min-width: 0;
                  flex: 1;
              }

              .monitor-label {
                  font-size: 10px;
                  white-space: nowrap;
              }

              .monitor-value {
                  font-size: 12px;
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  max-width: 80px;
              }

              /* 标签移动端适配 */
              .server-tags {
                  gap: 4px;
                  flex-wrap: wrap;
              }

              .server-tag {
                  padding: 2px 6px;
                  font-size: 10px;
                  white-space: nowrap;
              }

              /* 服务器类型徽章 */
              .server-type-badge {
                  padding: 2px 6px;
                  font-size: 10px;
                  gap: 2px;
                  white-space: nowrap;
              }

              .server-type-badge .iconfont {
                  font-size: 10px;
              }

              /* 操作按钮移动端适配 */
              .server-actions {
                  gap: 6px;
              }

              .action-btn {
                  width: 28px;
                  height: 28px;
                  padding: 0;
              }

              .action-btn .iconfont {
                  font-size: 12px;
              }

              /* 页脚移动端适配 */
              .footer {
                  padding: 10px 5px;
                  margin-top: 20px;
              }

              .footer-content {
                  flex-direction: row !important;
                  gap: 6px !important;
                  text-align: center;
                  align-items: center;
                  justify-content: center;
                  flex-wrap: nowrap !important;
              }

              .footer-text {
                  font-size: 10px !important;
                  white-space: nowrap;
              }

              .footer-divider {
                  font-size: 10px !important;
              }

              .footer-links {
                  justify-content: center;
                  flex-wrap: nowrap !important;
                  gap: 4px;
              }

              .footer-link {
                  font-size: 10px !important;
                  padding: 2px 4px;
                  white-space: nowrap;
              }

              .footer-link .iconfont {
                  font-size: 10px !important;
              }

              /* 系统设置选项卡移动端适配 - 只显示图标 */
              .settings-nav-item {
                  padding: 12px 8px !important;
                  font-size: 0 !important;
                  justify-content: center !important;
                  min-width: 0 !important;
                  flex: 1 !important;
              }

              .settings-nav-item span {
                  display: none !important;
              }

              .settings-nav-item i {
                  font-size: 18px !important;
                  margin: 0 !important;
              }

              /* 模态框移动端适配 */
              .modal-content {
                  width: calc(100% - 20px);
                  max-width: none;
                  margin: 10px;
                  max-height: 85vh;
                  overflow-y: auto;
                  padding: 20px !important;
                  box-sizing: border-box;
              }

              .modal-header {
                  padding: 0 0 15px 0;
                  margin-bottom: 15px;
              }

              .modal-body {
                  padding: 0;
              }

              .modal-footer {
                  padding: 15px 0 0 0;
                  gap: 8px;
              }

              /* 表单元素移动端适配 */
              .form-grid {
                  grid-template-columns: 1fr !important;
                  gap: 15px !important;
              }

              .form-group {
                  margin-bottom: 15px;
                  grid-column: 1 !important;
              }

              .form-group.full-width {
                  grid-column: 1 !important;
              }

              .form-group.inline-flex {
                  flex-direction: column !important;
                  gap: 8px !important;
                  align-items: stretch !important;
              }

              .form-group.inline-flex > div {
                  flex: none !important;
                  width: 100% !important;
              }

              .form-control {
                  padding: 10px;
                  font-size: 14px;
                  width: 100% !important;
                  box-sizing: border-box !important;
              }

              /* 内联元素移动端适配 */
              .form-group div[style*="display: flex"] {
                  flex-direction: column !important;
                  gap: 8px !important;
                  align-items: stretch !important;
              }

              .form-group div[style*="display: flex"] input,
              .form-group div[style*="display: flex"] select {
                  width: 100% !important;
                  flex: none !important;
                  box-sizing: border-box !important;
              }

              .form-group div[style*="display: flex"] span {
                  text-align: left !important;
                  margin-left: 0 !important;
              }

              /* 特殊处理：提前通知天数 - 保持水平布局 */
              .form-group div[style*="display: flex"][style*="align-items: center"] {
                  flex-direction: row !important;
                  gap: 8px !important;
                  align-items: center !important;
              }

              .form-group div[style*="display: flex"][style*="align-items: center"] input {
                  flex: 1 !important;
                  width: auto !important;
                  box-sizing: border-box !important;
              }

              .form-group div[style*="display: flex"][style*="align-items: center"] span {
                  flex: none !important;
                  white-space: nowrap !important;
              }

              /* 特殊处理：续期周期 - 保持水平布局且数字输入框和单位选择框等长 */
              .form-group div[style*="display: flex"][style*="gap: 8px"]:not([style*="align-items: center"]) {
                  flex-direction: row !important;
                  gap: 8px !important;
                  align-items: center !important;
              }

              .form-group div[style*="display: flex"][style*="gap: 8px"]:not([style*="align-items: center"]) input {
                  flex: 1 !important;
                  width: auto !important;
                  min-width: 0 !important;
                  box-sizing: border-box !important;
              }

              .form-group div[style*="display: flex"][style*="gap: 8px"]:not([style*="align-items: center"]) select {
                  flex: 1 !important;
                  width: auto !important;
                  min-width: 0 !important;
                  box-sizing: border-box !important;
                  font-size: 14px !important;
                  padding: 8px 6px !important;
              }

              /* 续期界面单位选择框样式 - 与编辑界面保持一致 */
              #renewalUnit {
                  width: 50px !important;
                  min-width: 50px !important;
                  max-width: 50px !important;
                  box-sizing: border-box !important;
                  font-size: 14px !important;
                  padding: 8px 4px !important;
                  text-align: center !important;
              }

              /* 保持添加/编辑服务器表单中的续期周期单位选择框样式 */
              #renewalPeriodUnit,
              #editRenewalPeriodUnit {
                  width: 40px !important;
                  min-width: 40px !important;
                  max-width: 40px !important;
                  box-sizing: border-box !important;
                  font-size: 12px !important;
                  padding: 8px 2px !important;
                  text-align: center !important;
              }

              /* 特殊处理：价格 - 保持水平布局但限制宽度 */
              .form-group div[style*="display: flex"][style*="gap: 6px"] {
                  flex-direction: row !important;
                  gap: 6px !important;
                  align-items: center !important;
              }

              .form-group div[style*="display: flex"][style*="gap: 6px"] select {
                  flex: none !important;
                  width: 60px !important;
                  min-width: 60px !important;
                  box-sizing: border-box !important;
                  font-size: 14px !important;
                  padding: 8px 6px !important;
                  text-align: center !important;
              }

              .form-group div[style*="display: flex"][style*="gap: 6px"] input {
                  flex: 2 !important;
                  width: auto !important;
                  min-width: 0 !important;
                  box-sizing: border-box !important;
              }

              /* 额外确保价格相关选择框显示完整 */
              #priceCurrency,
              #editPriceCurrency {
                  width: 60px !important;
                  min-width: 60px !important;
                  font-size: 14px !important;
                  padding: 8px 6px !important;
                  text-align: center !important;
              }

              /* 颜色选择按钮容器 - 保持水平布局 */
              .color-options {
                  display: flex !important;
                  flex-direction: row !important;
                  justify-content: flex-start !important;
                  flex-wrap: nowrap !important;
                  gap: 6px !important;
                  overflow-x: auto !important;
                  overflow-y: visible !important;
                  padding: 6px 4px !important;
                  margin: 4px 0 !important;
              }

              .color-options .color-btn {
                  flex: none !important;
                  min-width: 24px !important;
                  width: 24px !important;
                  height: 24px !important;
                  margin: 0 !important;
              }

              /* 标签颜色选择区域容器 */
              .tag-color-selection {
                  overflow: visible !important;
              }

              .btn {
                  padding: 8px 16px;
                  font-size: 14px;
                  touch-action: manipulation;
              }

              /* 通知容器移动端适配 */
              .notification {
                  margin: 5px;
                  padding: 12px;
                  font-size: 14px;
              }

              /* 隐藏在移动端不必要的元素 */
              .github-corner {
                  display: none;
              }

              /* 确保文本不会溢出 */
              * {
                  word-wrap: break-word;
                  word-break: break-word;
                  overflow-wrap: break-word;
              }

              /* 防止水平滚动 */
              body {
                  overflow-x: hidden;
              }

              /* 优化触摸操作 */
              .btn, .action-btn, .server-card {
                  touch-action: manipulation;
              }
          }
          
          /* iPad及中等屏幕优化 */
          /* iPad端不再需要特殊的服务器卡片样式，使用统一的自适应设计 */
          
          /* 时间显示 */
          .current-time {
              font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Courier New', monospace;
              font-weight: 600;
              color: var(--text-primary);
          }
          
          /* 自定义确认对话框 */
          .confirm-overlay {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0, 0, 0, 0.5);
              z-index: 3000;
              justify-content: center;
              align-items: center;
          }
          
          .confirm-overlay.show {
              display: flex;
          }
          
          .confirm-dialog {
              background: var(--bg-primary);
              border: 1px solid var(--border-color);
              border-radius: 12px;
              padding: 24px;
              max-width: 400px;
              width: 90%;
              box-shadow: 0 10px 30px var(--shadow-color);
              animation: confirmSlideIn 0.2s ease;
          }
          
          @keyframes confirmSlideIn {
              from {
                  opacity: 0;
                  transform: scale(0.9) translateY(-20px);
              }
              to {
                  opacity: 1;
                  transform: scale(1) translateY(0);
              }
          }
          
          .confirm-icon {
              width: 48px;
              height: 48px;
              margin: 0 auto 16px;
              display: flex;
              align-items: center;
              justify-content: center;
              background: var(--primary-color);
              color: white;
              border-radius: 50%;
              font-size: 24px;
          }
          
          .confirm-title {
              font-size: 18px;
              font-weight: 600;
              color: var(--text-primary);
              text-align: center;
              margin-bottom: 8px;
          }
          
          .confirm-message {
              font-size: 14px;
              color: var(--text-secondary);
              text-align: center;
              margin-bottom: 24px;
              line-height: 1.5;
          }
          
          .confirm-actions {
              display: flex;
              gap: 12px;
              justify-content: center;
          }
          
          .confirm-btn {
              padding: 10px 24px;
              border: none;
              border-radius: 6px;
              font-size: 14px;
              font-weight: 500;
              cursor: pointer;
              transition: all 0.2s;
              min-width: 80px;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 6px;
          }
          
          .confirm-btn-primary {
              background: var(--danger-color);
              color: white;
          }
          
          .confirm-btn-primary:hover {
              background: var(--danger-color);
              opacity: 0.9;
              transform: translateY(-1px);
          }
          
          .confirm-btn-secondary {
              background: var(--text-secondary);
              color: white;
          }
          
          .confirm-btn-secondary:hover {
              background: var(--text-secondary-hover);
              color: white;
              transform: translateY(-1px);
          }
          
          /* 通知提示框容器 */
          .notification-container {
              position: fixed;
              top: 20px;
              right: 20px;
              z-index: 4000;
              display: flex;
              flex-direction: column;
              gap: 10px;
              pointer-events: none;
          }

          /* 通知提示框 */
          .notification {
              background: var(--bg-primary);
              border-radius: 8px;
              padding: 16px 20px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
              max-width: 400px;
              min-width: 300px;
              transform: translateX(100%);
              transition: all 0.3s ease;
              border-left: 4px solid var(--primary-color);
              pointer-events: auto;
              opacity: 0;
          }
          
          .notification.show {
              transform: translateX(0);
              opacity: 1;
          }
          
          .notification.success {
              border-left-color: var(--success-color);
          }
          
          .notification.error {
              border-left-color: var(--danger-color);
          }
          
          .notification.warning {
              border-left-color: var(--warning-color);
          }
          
          .notification-content {
              display: grid;
              grid-template-columns: auto 1fr auto;
              align-items: center;
              gap: 12px;
          }
          
          .notification-icon {
              font-size: 16px;
              line-height: 14px;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 14px;
          }
          
          .notification-text {
              font-size: 14px;
              color: var(--text-secondary);
              line-height: 14px;
              display: flex;
              align-items: center;
              height: 14px;
          }
          
          .notification-close {
              background: none;
              border: none;
              color: var(--text-secondary);
              cursor: pointer;
              font-size: 16px;
              padding: 0;
              width: 16px;
              height: 14px;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 50%;
              transition: all 0.2s;
              line-height: 14px;
          }

          .notification-close:hover {
              background: var(--hover-bg);
              color: var(--text-secondary);
          }

          /* 勾选框包装器样式 */
          .checkbox-wrapper {
              display: flex;
              align-items: center;
              gap: 8px;
              margin-bottom: 8px;
          }

          .checkbox-wrapper input[type="checkbox"] {
              width: 16px;
              height: 16px;
              margin: 0;
              cursor: pointer;
              accent-color: var(--primary-color);
              border-radius: 3px;
          }

          .checkbox-wrapper label {
              margin: 0;
              cursor: pointer;
              color: var(--text-primary);
              font-weight: 500;
              font-size: 14px;
              line-height: 1.4;
              user-select: none;
          }

          /* 移动端适配 */
          @media (max-width: 768px) {
              .checkbox-wrapper {
                  gap: 10px;
              }

              .checkbox-wrapper input[type="checkbox"] {
                  width: 18px;
                  height: 18px;
              }

              .checkbox-wrapper label {
                  font-size: 15px;
              }
          }
      </style>
  </head>
  <body>
      <!-- 通知容器 -->
      <div class="notification-container" id="notificationContainer"></div>
      
      <!-- 顶部导航栏 -->
      <nav class="navbar">
          <div class="navbar-content">
              <div class="logo"><img src="${logoUrl}" alt="Logo" class="${logoClass}"> ${siteTitle}</div>
              <div class="nav-actions">
                  <div class="theme-toggle-wrapper">
                      <label class="theme-toggle" for="theme-switch">
                          <input type="checkbox" id="theme-switch" onchange="toggleTheme()">
                          <span class="slider">
                              <i class="iconfont icon-taiyang sun-icon"></i>
                              <i class="iconfont icon-zhutiqiehuan moon-icon"></i>
                          </span>
                      </label>
                  </div>
                  <button class="bg-toggle-btn" onclick="handleNezhaClick()" id="nezhaBtn" title="哪吒监控">
                      <i class="iconfont icon-a-nezha1"></i>
                  </button>
                  <button class="bg-toggle-btn" onclick="toggleBackgroundImage()" id="bgToggleBtn" title="开关背景图">
                      <i class="iconfont icon-images"></i>
                  </button>
                  <button class="bg-toggle-btn" onclick="showSettingsModal()" title="系统设置"><i class="iconfont icon-gear"></i></button>
                  <button class="bg-toggle-btn" onclick="logout()" id="logoutBtn" style="display: none;" title="退出登录"><i class="iconfont icon-sign-out-alt"></i></button>
              </div>
          </div>
      </nav>
      
      <main class="main-content">
          <div class="container">
          <!-- Overview区域 -->
          <div class="overview-section">
              <div class="overview-left">
                  <div class="overview-title">${welcomeMessage}</div>
                  <div class="overview-time"><span class="current-time" id="currentTime"></span></div>
                  
                  <!-- 统计卡片 -->
                  <div class="stats-grid">
                      <div class="stat-card total" onclick="filterServers('all')" title="点击查看所有服务器">
                          <h3><i class="iconfont icon-circle-info"></i> 总服务器</h3>
                          <div class="value" id="totalServers">
                              <span class="status-indicator online"></span>
                              0
                          </div>
                      </div>
                      <div class="stat-card online" onclick="filterServers('online')" title="点击只查看正常运行的服务器">
                          <h3><i class="iconfont icon-circle-check"></i> 正常运行</h3>
                          <div class="value" id="onlineServers">
                              <span class="status-indicator online"></span>
                              0
                          </div>
                      </div>
                      <div class="stat-card warning" onclick="filterServers('warning')" title="点击只查看即将过期的服务器">
                          <h3><i class="iconfont icon-bullhorn"></i> 即将过期</h3>
                          <div class="value" id="expiringSoon">
                              <span class="status-indicator warning"></span>
                              0
                          </div>
                      </div>
                      <div class="stat-card offline" onclick="filterServers('offline')" title="点击只查看已过期的服务器">
                          <h3><i class="iconfont icon-triangle-exclamation"></i> 已过期</h3>
                          <div class="value" id="offlineServers">
                              <span class="status-indicator offline"></span>
                              0
                          </div>
                      </div>
                  </div>
              </div>
          </div>
          
          <!-- 服务器列表 -->
          <div class="servers-section">
              <div class="section-header">
                  <div class="section-title"><i class="iconfont icon-list-ul"></i> 服务器列表</div>
                  <div class="section-actions">
                      <div class="sort-dropdown-container">
                          <button class="btn btn-primary" onclick="toggleSortDropdown()" id="sortButton">
                              <i class="iconfont icon-paixu"></i> 排序
                          </button>
                          <div class="sort-dropdown" id="sortDropdown">
                              <!-- 按添加时间排序 -->
                              <div class="sort-option" onclick="setSortOption('addTime', 'asc')">
                                  <span>按添加时间升序</span>
                                  <i class="iconfont icon-check" id="check-addTime-asc"></i>
                              </div>
                              <div class="sort-option" onclick="setSortOption('addTime', 'desc')">
                                  <span>按添加时间降序</span>
                                  <i class="iconfont icon-check" id="check-addTime-desc"></i>
                              </div>
                              
                              <!-- 分隔线 -->
                              <div class="sort-divider"></div>
                              
                              <!-- 按服务器名称排序 -->
                              <div class="sort-option" onclick="setSortOption('name', 'asc')">
                                  <span>按服务器名称升序</span>
                                  <i class="iconfont icon-check" id="check-name-asc"></i>
                              </div>
                              <div class="sort-option" onclick="setSortOption('name', 'desc')">
                                  <span>按服务器名称降序</span>
                                  <i class="iconfont icon-check" id="check-name-desc"></i>
                              </div>
                              
                              <!-- 分隔线 -->
                              <div class="sort-divider"></div>
                              
                              <!-- 按服务商排序 -->
                              <div class="sort-option" onclick="setSortOption('provider', 'asc')">
                                  <span>按服务商升序</span>
                                  <i class="iconfont icon-check" id="check-provider-asc"></i>
                              </div>
                              <div class="sort-option" onclick="setSortOption('provider', 'desc')">
                                  <span>按服务商降序</span>
                                  <i class="iconfont icon-check" id="check-provider-desc"></i>
                              </div>
                              
                              <!-- 分隔线 -->
                              <div class="sort-divider"></div>
                              
                              <!-- 按剩余天数排序 -->
                              <div class="sort-option" onclick="setSortOption('daysLeft', 'asc')">
                                  <span>按剩余天数升序</span>
                                  <i class="iconfont icon-check" id="check-daysLeft-asc"></i>
                              </div>
                              <div class="sort-option" onclick="setSortOption('daysLeft', 'desc')">
                                  <span>按剩余天数降序</span>
                                  <i class="iconfont icon-check" id="check-daysLeft-desc"></i>
                              </div>
                              
                              <!-- 分隔线 -->
                              <div class="sort-divider"></div>
                              
                              <!-- 按标签排序 -->
                              <div class="sort-option" onclick="setSortOption('tags', 'asc')">
                                  <span>按标签升序</span>
                                  <i class="iconfont icon-check" id="check-tags-asc"></i>
                              </div>
                              <div class="sort-option" onclick="setSortOption('tags', 'desc')">
                                  <span>按标签降序</span>
                                  <i class="iconfont icon-check" id="check-tags-desc"></i>
                              </div>
                          </div>
                      </div>
                      <button class="btn btn-primary" onclick="showAddServerModal('')"><i class="iconfont icon-jia1"></i> 添加服务器</button>
                      <button class="btn btn-primary" onclick="showCategoryModal()"><i class="iconfont icon-fenlei"></i> 分类管理</button>
                  </div>
              </div>
              <div class="servers-grid" id="serversGrid">
                  <!-- 服务器卡片将在这里动态生成 -->
              </div>
          </div>
      </main>
      
      <!-- 添加服务器模态框 -->
      <div class="modal" id="addServerModal">
          <div class="modal-content">
              <div class="modal-header">
                  <div class="modal-title-section">
                      <div class="modal-title">添加新服务器</div>
                      <button class="import-btn-header" id="importFromClipboardBtn" title="从剪贴板导入服务器信息">
                          <i class="iconfont icon-paste"></i>
                      </button>
                  </div>
                  <button class="close-btn" onclick="hideAddServerModal()" title="关闭 (ESC)">&times;</button>
              </div>
              <form id="addServerForm">
                  <div class="form-grid">
                      <div class="form-group full-width">
                          <label for="serverName"><i class="iconfont icon-hollow-computer"></i> 服务器名称<span class="required">*</span></label>
                          <input type="text" id="serverName" required placeholder="例如：🇺🇸US-AWS 或 阿里云ECS-1">
                      </div>
                      <div class="form-group">
                          <label for="serverProvider"><i class="iconfont icon-zhuye"></i> 服务厂商</label>
                          <div class="provider-container">
                              <select id="serverProvider" onchange="toggleCustomProvider()">
                                  <option value="">选择服务厂商</option>
                                  <option value="阿里云">阿里云</option>
                                  <option value="腾讯云">腾讯云</option>
                                  <option value="华为云">华为云</option>
                                  <option value="AWS">AWS</option>
                                  <option value="Google Cloud">Google Cloud</option>
                                  <option value="Azure">Azure</option>
                                  <option value="Vultr">Vultr</option>
                                  <option value="DigitalOcean">DigitalOcean</option>
                                  <option value="Linode">Linode</option>
                                  <option value="CloudCone">CloudCone</option>
                                  <option value="搬瓦工">搬瓦工</option>
                                  <option value="其他">其他</option>
                              </select>
                              <input type="text" id="customProvider" placeholder="请输入服务商名称" style="display: none;" onblur="handleCustomProviderBlur()">
                              <button type="button" id="backToSelect" onclick="backToSelectProvider()" style="display: none; margin-left: 8px; padding: 6px 12px; background: #f1f5f9; border: 1px solid #e1e8ed; border-radius: 4px; cursor: pointer; font-size: 12px;">返回选择</button>
                          </div>
                      </div>
                      <div class="form-group">
                          <label for="serverCategory"><i class="iconfont icon-fenlei"></i> 所属分类</label>
                          <select id="serverCategory">
                              <option value="">默认分类</option>
                          </select>
                      </div>
                      <div class="form-group">
                          <label for="serverIP"><i class="iconfont icon-earth-full"></i> IP地址<span class="required">*</span></label>
                          <input type="text" id="serverIP" required placeholder="例如：192.168.1.1">
                      </div>
                      <div class="form-group">
                          <label for="notifyDays"><i class="iconfont icon-lingdang"></i> 提前通知天数</label>
                          <div style="display: flex; align-items: center; gap: 8px;">
                              <input type="number" id="notifyDays" value="14" min="1" placeholder="14" style="flex: 1;">
                              <span style="color: #95a5a6; font-size: 12px;">天</span>
                          </div>
                      </div>
                      <div class="form-group full-width">
                          <label for="serverTags"><i class="iconfont icon-tianchongxing-"></i> 自定义标签</label>
                          <input type="text" id="serverTags" placeholder="请输入自定义标签">
                          <div class="tag-color-selection" style="margin-top: 6px;">
                              <div style="font-size: 11px; color: #95a5a6; margin-bottom: 4px;">选择颜色：</div>
                                                        <div class="color-options" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                              <button type="button" class="color-btn tag-color-red" data-color-light="#dc3545" data-color-dark="#ff6b6b" style="background: var(--tag-red);" onclick="selectTagColor('red')" title="红色"></button>
                              <button type="button" class="color-btn tag-color-orange" data-color-light="#ffc107" data-color-dark="#ffc107" style="background: var(--tag-orange);" onclick="selectTagColor('orange')" title="橙色"></button>
                              <button type="button" class="color-btn tag-color-green" data-color-light="#28a745" data-color-dark="#40d962" style="background: var(--tag-green);" onclick="selectTagColor('green')" title="绿色"></button>
                              <button type="button" class="color-btn tag-color-blue" data-color-light="#007BFF" data-color-dark="#74c0fc" style="background: var(--tag-blue);" onclick="selectTagColor('blue')" title="蓝色"></button>
                              <button type="button" class="color-btn tag-color-purple" data-color-light="#9b59b6" data-color-dark="#be4bdb" style="background: var(--tag-purple);" onclick="selectTagColor('purple')" title="紫色"></button>
                              <div class="tag-preview server-type-badge" id="tagPreview" style="margin-left: 12px; display: none;"><i class="iconfont icon-tags"></i>预览标签</div>
                          </div>
                          <input type="hidden" id="tagColor" value="red">
                          </div>
                      </div>
                      <div class="form-group">
                          <label for="registerDate"><i class="iconfont icon-calendar-days"></i> 注册日期<span class="required">*</span></label>
                          <input type="date" id="registerDate" required>
                      </div>
                      <div class="form-group">
                          <label for="renewalPeriodNum"><i class="iconfont icon-repeat"></i> 续期周期<span class="required">*</span></label>
                          <div style="display: flex; gap: 8px; align-items: center;">
                              <input type="number" id="renewalPeriodNum" required placeholder="数量" min="1" style="flex: 1;">
                              <select id="renewalPeriodUnit" style="width: 70px;">
                                  <option value="月">月</option>
                                  <option value="年">年</option>
                                  <option value="天">天</option>
                              </select>
                          </div>
                      </div>
                      <div class="form-group">
                          <label for="expireDate"><i class="iconfont icon-calendar-days"></i> 到期日期 <span style="font-size: 11px; color: #95a5a6; font-weight: normal;">（根据注册日期和续期周期自动计算）</span></label>
                          <input type="date" id="expireDate">
                      </div>
                      <div class="form-group">
                          <label for="priceAmount"><i class="iconfont icon-licai"></i> 价格</label>
                          <div style="display: flex; gap: 6px; align-items: center;">
                              <select id="priceCurrency" style="width: 60px;">
                                  <option value="CNY">¥</option>
                                  <option value="USD">$</option>
                                  <option value="EUR">€</option>
                                  <option value="GBP">£</option>
                                  <option value="RUB">₽</option>
                              </select>
                              <input type="number" id="priceAmount" placeholder="金额" step="0.01" style="flex: 1; min-width: 80px;">
                              <select id="priceUnit" style="width: 80px;">
                                  <option value="/月">/月</option>
                                  <option value="/年">/年</option>
                                  <option value="/天">/天</option>
                              </select>
                          </div>
                      </div>
                      <div class="form-group full-width">
                          <label for="renewalLink"><i class="iconfont icon-link"></i> 续期链接</label>
                          <input type="url" id="renewalLink" placeholder="续期链接">
                      </div>
                  </div>
                  <div class="form-actions">
                      <button type="button" class="btn btn-secondary" onclick="hideAddServerModal()" title="取消并关闭">取消</button>
                      <button type="submit" class="btn btn-primary">
                          <i class="iconfont icon-gou1"></i>
                          添加服务器
                      </button>
                  </div>
              </form>
          </div>
      </div>
      
      <!-- 分类管理模态框 -->
      <div class="modal" id="categoryModal">
          <div class="modal-content">
              <div class="modal-header">
                  <div class="modal-title">分类管理</div>
                  <button class="close-btn" onclick="hideCategoryModal()" title="关闭 (ESC)">&times;</button>
              </div>
              
              <!-- 添加分类表单 -->
              <form id="addCategoryForm" style="margin-bottom: 24px;">
                  <div class="form-grid">
                      <div class="form-group">
                          <label for="categoryName"><i class="iconfont icon-shapes"></i> 分类名称 *</label>
                          <input type="text" id="categoryName" required placeholder="例如：生产环境">
                      </div>
                      <div class="form-group">
                          <label for="categoryDescription"><i class="iconfont icon-bianji"></i> 描述</label>
                          <input type="text" id="categoryDescription" placeholder="分类描述">
                      </div>
                  </div>
                  <div style="margin-top: 16px;">
                      <button type="submit" class="btn btn-primary"><i class="iconfont icon-jia1"></i> 添加分类</button>
                  </div>
              </form>
              
              <!-- 分类列表 -->
              <div style="border-top: 1px solid var(--border-color); padding-top: 20px;">
                  <h4 style="margin-bottom: 16px; color: var(--text-primary);">现有分类</h4>
                  <div id="categoryList">
                      <!-- 分类列表将在这里显示 -->
                  </div>
              </div>
          </div>
      </div>

      <!-- 设置模态框 -->
      <div class="modal" id="settingsModal">
          <div class="modal-content settings-modal-content">
              <div class="modal-header">
                  <div class="modal-title">系统设置</div>
                  <button class="close-btn" onclick="hideSettingsModal()" title="关闭 (ESC)">&times;</button>
              </div>
              
              <div class="settings-body">
                  <!-- 顶部标签页导航 -->
                  <div class="settings-nav">
                      <div class="settings-nav-item active" onclick="switchSettingsTab('basic')" id="basicTabBtn">
                          <i class="iconfont icon-gear"></i>
                          <span>基础设置</span>
                      </div>
                      <div class="settings-nav-item" onclick="switchSettingsTab('notification')" id="notificationTabBtn">
                          <i class="iconfont icon-paper-plane"></i>
                          <span>通知设置</span>
                      </div>
                      <div class="settings-nav-item" onclick="switchSettingsTab('security')" id="securityTabBtn">
                          <i class="iconfont icon-shield-full"></i>
                          <span>安全设置</span>
                      </div>
                  </div>
                  
                  <!-- 设置内容区域 -->
                  <div class="settings-content">
                      <form id="settingsForm">
                          <!-- 基础设置标签页 -->
                          <div class="settings-tab active" id="basicTab">
                              <h3 class="settings-tab-title"><i class="iconfont icon-program-full"></i> 界面自定义设置</h3>
                              
                              <div class="form-group" style="margin-bottom: 30px;">
                                  <label for="customLogoUrl"><i class="iconfont icon-shouye"></i> 网站Logo</label>
                                  <input type="url" id="customLogoUrl" placeholder="https://example.com/logo.svg">
                                  <div class="form-help">
                                      输入Logo图片的URL链接，留空则使用默认Logo。建议使用SVG、PNG格式，支持透明背景
                                  </div>
                              </div>
                              
                              <div class="form-group" style="margin-bottom: 24px;">
                                  <label for="siteTitle"><i class="iconfont icon-yumaobi"></i> 网站标题</label>
                                  <input type="text" id="siteTitle" placeholder="服务器到期监控" maxlength="50">
                                  <div class="form-help">
                                      显示在页面顶部导航栏的标题文字
                                  </div>
                              </div>
                              
                              <div class="form-group" style="margin-bottom: 24px;">
                                  <label for="welcomeMessage"><i class="iconfont icon-guzhang"></i> 欢迎语</label>
                                  <input type="text" id="welcomeMessage" placeholder="Hello!" maxlength="100">
                                  <div class="form-help">
                                      显示在页面左上角的欢迎文字
                                  </div>
                              </div>
                              
                              <div class="form-group" style="margin-bottom: 30px;">
                                  <label for="nezhaMonitorUrl"><i class="iconfont icon-a-nezha1"></i> 哪吒监控网站</label>
                                  <input type="url" id="nezhaMonitorUrl" placeholder="https://nezha.example.com" maxlength="200">
                                  <div class="form-help">
                                      设置哪吒监控面板的URL，配置后顶部导航栏会显示快捷访问按钮
                                  </div>
                              </div>
                              
                              <div class="form-group" style="margin-bottom: 30px;">
                                  <label><i class="iconfont icon-images"></i> 自定义背景图</label>
                                  
                                  <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                      <label for="customDesktopBackgroundUrl" style="width: 60px; margin: 0; font-size: 14px; color: var(--text-secondary);">桌面端：</label>
                                      <input type="url" id="customDesktopBackgroundUrl" placeholder="https://example.com/desktop-background.jpg" style="flex: 1;">
                                  </div>
                                  
                                  <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                      <label for="customMobileBackgroundUrl" style="width: 60px; margin: 0; font-size: 14px; color: var(--text-secondary);">移动端：</label>
                                      <input type="url" id="customMobileBackgroundUrl" placeholder="https://example.com/mobile-background.jpg" style="flex: 1;">
                                  </div>
                                  
                                  <div class="form-help">
                                      分别设置桌面端和移动端的背景图片URL链接，留空则使用代码中的默认背景图。建议压缩图片大小，支持JPG、PNG、WebP格式
                                  </div>
                              </div>
                          </div>
                          
                          <!-- 通知设置标签页 -->
                          <div class="settings-tab" id="notificationTab">
                              <h3 class="settings-tab-title"><i class="iconfont icon-shouji"></i> Telegram通知设置</h3>
                              
                              <div class="form-group" style="margin-bottom: 24px;">
                                  <div class="checkbox-wrapper">
                                      <input type="checkbox" id="enableTelegramNotification" onchange="toggleTelegramConfig()">
                                      <label for="enableTelegramNotification">启用Telegram通知</label>
                                  </div>
                                  <div class="form-help">
                                      启用后可以接收服务器到期提醒和测试通知
                                  </div>
                              </div>
                              
                              <!-- 外置配置提示 -->
                              <div id="externalConfigNotice" class="form-notice" style="display: none; background-color: #e8f5e8; border-left: 4px solid #4CAF50; color: #2d5a2d;">
                                  <i class="iconfont icon-check-circle" style="color: #4CAF50; margin-right: 8px;"></i>
                                  <span id="externalConfigText">已在外置环境变量中配置Telegram参数，通知功能已自动启用且不可关闭。</span>
                              </div>
                              
                              <div id="telegramConfigSection">
                                  <div class="form-group" style="margin-bottom: 24px;">
                                      <label for="telegramBotToken"><i class="iconfont icon-key"></i> Bot Token</label>
                                      <div class="password-input-wrapper">
                                          <input type="password" id="telegramBotToken" placeholder="请输入Telegram Bot Token">
                                          <i class="iconfont icon-bukejian password-toggle" onclick="togglePasswordVisibility('telegramBotToken')" title="显示/隐藏Token"></i>
                                      </div>
                                      <div class="form-help" id="botTokenHelp">
                                          通过 @BotFather 创建机器人获取Token
                                      </div>
                                  </div>
                                  
                                  <div class="form-group" style="margin-bottom: 24px;">
                                      <label for="telegramChatId"><i class="iconfont icon-robot-2-fill"></i> Chat ID</label>
                                      <div class="password-input-wrapper">
                                          <input type="password" id="telegramChatId" placeholder="请输入Chat ID">
                                          <i class="iconfont icon-bukejian password-toggle" onclick="togglePasswordVisibility('telegramChatId')" title="显示/隐藏Chat ID"></i>
                                      </div>
                                      <div class="form-help" id="chatIdHelp">
                                          向 @userinfobot 发送消息获取您的Chat ID
                                      </div>
                                  </div>
                                  
                                  <div class="form-group" style="align-items: flex-start;">
                                      <button type="button" class="btn btn-primary" onclick="testTelegramNotification()" id="testTelegramBtn">
                                          <i class="iconfont icon-paper-plane"></i> 通知测试
                                      </button>
                                  </div>
                              </div>
                              
                              <h3 class="settings-tab-title" style="margin-top: 30px;"><i class="iconfont icon-lingdang"></i> 全局通知设置</h3>
                              
                              <div class="form-group" style="margin-bottom: 30px;">
                                  <label for="globalNotifyDays"><i class="iconfont icon-rili"></i> 默认提前通知天数</label>
                                  <div style="display: flex; align-items: center; gap: 8px;">
                                      <input type="number" id="globalNotifyDays" value="14" min="1" max="365" placeholder="14" style="flex: 1;">
                                      <span style="color: #95a5a6; font-size: 14px;">天</span>
                                  </div>
                                  <div class="form-help">
                                      此功能只在开启telegram通知才生效，用于全局控制提前通知天数
                                  </div>
                              </div>
                          </div>
                          
                          <!-- 安全设置标签页 -->
                          <div class="settings-tab" id="securityTab">
                              <h3 class="settings-tab-title"><i class="iconfont icon-shield-full"></i> 安全设置</h3>
                              
                              <div class="form-group" style="margin-bottom: 24px;">
                                  <div class="checkbox-wrapper">
                                      <input type="checkbox" id="enableAuth" onchange="toggleAuthConfig()">
                                      <label for="enableAuth">启用登录验证</label>
                                  </div>
                                  <div class="form-help">
                                      启用后访问系统需要输入密码，提高安全性
                                  </div>
                              </div>
                              
                              <!-- 外置认证配置提示 -->
                              <div id="externalAuthNotice" class="form-notice" style="display: none; background-color: #e8f5e8; border-left: 4px solid #4CAF50; color: #2d5a2d;">
                                  <i class="iconfont icon-check-circle" style="color: #4CAF50; margin-right: 8px;"></i>
                                  <span id="externalAuthText">已在外置环境变量中配置登录密码，验证功能已自动启用且不可关闭。</span>
                              </div>
                              
                              <div id="authConfigSection" style="opacity: 0.5;">
                                  <div class="form-group" style="margin-bottom: 24px;">
                                      <label for="loginPassword"><i class="iconfont icon-key"></i> 登录密码</label>
                                      <div class="password-input-wrapper">
                                          <input type="password" id="loginPassword" placeholder="请设置登录密码" maxlength="50" disabled>
                                          <i class="iconfont icon-bukejian password-toggle" onclick="togglePasswordVisibility('loginPassword')" title="显示/隐藏密码"></i>
                                      </div>
                                      <div class="form-help" id="loginPasswordHelp">
                                          用于登录系统的密码，建议使用复杂密码确保安全
                                      </div>
                                  </div>
                                  
                                  <div class="form-group" style="margin-bottom: 30px;">
                                      <label for="confirmPassword"><i class="iconfont icon-key"></i> 确认密码</label>
                                      <div class="password-input-wrapper">
                                          <input type="password" id="confirmPassword" placeholder="请再次输入密码" maxlength="50" disabled>
                                          <i class="iconfont icon-bukejian password-toggle" onclick="togglePasswordVisibility('confirmPassword')" title="显示/隐藏密码"></i>
                                      </div>
                                      <div class="form-help" id="confirmPasswordHelp">
                                          重复输入密码以确认
                                      </div>
                                  </div>
                              </div>
                          </div>
                          
                          <div class="form-actions">
                              <button type="button" class="btn btn-secondary" onclick="hideSettingsModal()">取消</button>
                              <button type="submit" class="btn btn-primary">
                                  <i class="iconfont icon-save-3-fill"></i>
                                  保存设置
                              </button>
                          </div>
                      </form>
                  </div>
              </div>
          </div>
      </div>

      <!-- 编辑服务器模态框 -->
      <div class="modal" id="editServerModal">
          <div class="modal-content">
              <div class="modal-header">
                  <div class="modal-title">编辑服务器信息</div>
                  <button class="close-btn" onclick="hideEditServerModal()" title="关闭 (ESC)">&times;</button>
              </div>
              <form id="editServerForm">
                  <div class="form-grid">
                      <div class="form-group full-width">
                          <label for="editServerName"><i class="iconfont icon-hollow-computer"></i> 服务器名称<span class="required">*</span></label>
                          <input type="text" id="editServerName" required placeholder="例如：🇺🇸US-AWS 或 阿里云ECS-1">
                      </div>
                      <div class="form-group">
                          <label for="editServerProvider"><i class="iconfont icon-zhuye"></i> 服务厂商</label>
                          <div class="provider-container">
                              <select id="editServerProvider" onchange="toggleEditCustomProvider()">
                                  <option value="">选择服务厂商</option>
                                  <option value="阿里云">阿里云</option>
                                  <option value="腾讯云">腾讯云</option>
                                  <option value="华为云">华为云</option>
                                  <option value="AWS">AWS</option>
                                  <option value="Google Cloud">Google Cloud</option>
                                  <option value="Azure">Azure</option>
                                  <option value="Vultr">Vultr</option>
                                  <option value="DigitalOcean">DigitalOcean</option>
                                  <option value="Linode">Linode</option>
                                  <option value="CloudCone">CloudCone</option>
                                  <option value="搬瓦工">搬瓦工</option>
                                  <option value="其他">其他</option>
                              </select>
                              <input type="text" id="editCustomProvider" placeholder="请输入服务商名称" style="display: none;" onblur="handleEditCustomProviderBlur()">
                              <button type="button" id="editBackToSelect" onclick="backToEditSelectProvider()" style="display: none; margin-left: 8px; padding: 6px 12px; background: #f1f5f9; border: 1px solid #e1e8ed; border-radius: 4px; cursor: pointer; font-size: 12px;">返回选择</button>
                          </div>
                      </div>
                      <div class="form-group">
                          <label for="editServerCategory"><i class="iconfont icon-fenlei"></i> 所属分类</label>
                          <select id="editServerCategory">
                              <option value="">默认分类</option>
                          </select>
                      </div>
                      <div class="form-group">
                          <label for="editServerIP"><i class="iconfont icon-earth-full"></i> IP地址<span class="required">*</span></label>
                          <input type="text" id="editServerIP" required placeholder="例如：192.168.1.1">
                      </div>
                      <div class="form-group">
                          <label for="editNotifyDays"><i class="iconfont icon-lingdang"></i> 提前通知天数</label>
                          <div style="display: flex; align-items: center; gap: 8px;">
                              <input type="number" id="editNotifyDays" value="14" min="1" placeholder="14" style="flex: 1;">
                              <span style="color: #95a5a6; font-size: 12px;">天</span>
                          </div>
                      </div>
                      <div class="form-group full-width">
                          <label for="editServerTags"><i class="iconfont icon-tianchongxing-"></i> 自定义标签</label>
                          <input type="text" id="editServerTags" placeholder="请输入自定义标签">
                          <div class="tag-color-selection" style="margin-top: 6px;">
                              <div style="font-size: 11px; color: #95a5a6; margin-bottom: 4px;">选择颜色：</div>
                                                        <div class="color-options" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                              <button type="button" class="color-btn tag-color-red" data-color-light="#dc3545" data-color-dark="#ff6b6b" style="background: var(--tag-red);" onclick="selectEditTagColor('red')" title="红色"></button>
                              <button type="button" class="color-btn tag-color-orange" data-color-light="#ffc107" data-color-dark="#ffc107" style="background: var(--tag-orange);" onclick="selectEditTagColor('orange')" title="橙色"></button>
                              <button type="button" class="color-btn tag-color-green" data-color-light="#28a745" data-color-dark="#40d962" style="background: var(--tag-green);" onclick="selectEditTagColor('green')" title="绿色"></button>
                              <button type="button" class="color-btn tag-color-blue" data-color-light="#007BFF" data-color-dark="#74c0fc" style="background: var(--tag-blue);" onclick="selectEditTagColor('blue')" title="蓝色"></button>
                              <button type="button" class="color-btn tag-color-purple" data-color-light="#9b59b6" data-color-dark="#be4bdb" style="background: var(--tag-purple);" onclick="selectEditTagColor('purple')" title="紫色"></button>
                              <div class="tag-preview server-type-badge" id="editTagPreview" style="margin-left: 12px; display: none;"><i class="iconfont icon-tags"></i>预览标签</div>
                          </div>
                          <input type="hidden" id="editTagColor" value="red">
                          </div>
                      </div>
                      <div class="form-group">
                          <label for="editRegisterDate"><i class="iconfont icon-calendar-days"></i> 注册日期<span class="required">*</span></label>
                          <input type="date" id="editRegisterDate" required>
                      </div>
                      <div class="form-group">
                          <label for="editRenewalPeriodNum"><i class="iconfont icon-repeat"></i> 续期周期<span class="required">*</span></label>
                          <div style="display: flex; gap: 8px; align-items: center;">
                              <input type="number" id="editRenewalPeriodNum" required placeholder="数量" min="1" style="flex: 1;">
                              <select id="editRenewalPeriodUnit" style="width: 70px;">
                                  <option value="月">月</option>
                                  <option value="年">年</option>
                                  <option value="天">天</option>
                              </select>
                          </div>
                      </div>
                      <div class="form-group full-width" id="editLastRenewalGroup" style="display: none;">
                          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                              <label for="editLastRenewalDate" style="margin: 0;"><i class="iconfont icon-calendar-days"></i> 上次续期日期</label>
                              <button type="button" class="btn btn-secondary" onclick="clearLastRenewalDate()" style="padding: 4px 8px; font-size: 11px; background-color: var(--danger-color); border-color: var(--danger-color); color: white;">清除</button>
                          </div>
                          <input type="date" id="editLastRenewalDate" readonly style="background: #f8f9fa; cursor: not-allowed;">
                          <div style="font-size: 11px; color: #95a5a6; margin-top: 3px;">
                              清除后将根据注册日期+续期周期重新计算到期日期
                          </div>
                      </div>
                      <div class="form-group">
                          <label for="editExpireDate"><i class="iconfont icon-calendar-days"></i> 到期日期 <span style="font-size: 11px; color: #95a5a6; font-weight: normal;">（根据注册日期和续期周期自动计算）</span></label>
                          <input type="date" id="editExpireDate">
                      </div>
                      <div class="form-group">
                          <label for="editPriceAmount"><i class="iconfont icon-licai"></i> 价格</label>
                          <div style="display: flex; gap: 6px; align-items: center;">
                              <select id="editPriceCurrency" style="width: 60px;">
                                  <option value="CNY">¥</option>
                                  <option value="USD">$</option>
                                  <option value="EUR">€</option>
                                  <option value="GBP">£</option>
                                  <option value="RUB">₽</option>
                              </select>
                              <input type="number" id="editPriceAmount" placeholder="金额" step="0.01" style="flex: 1; min-width: 80px;">
                              <select id="editPriceUnit" style="width: 80px;">
                                  <option value="/月">/月</option>
                                  <option value="/年">/年</option>
                                  <option value="/天">/天</option>
                              </select>
                          </div>
                      </div>
                      <div class="form-group full-width">
                          <label for="editRenewalLink"><i class="iconfont icon-link"></i> 续期链接</label>
                          <input type="url" id="editRenewalLink" placeholder="续期链接">
                      </div>
                  </div>
                  <div class="form-actions">
                      <button type="button" class="btn btn-secondary" onclick="hideEditServerModal()" title="取消并关闭">取消</button>
                      <button type="submit" class="btn btn-primary">
                          <i class="iconfont icon-save-3-fill"></i>
                          保存修改
                      </button>
                  </div>
              </form>
          </div>
      </div>

      <!-- 续期模态框 -->
      <div class="modal" id="renewalModal">
          <div class="modal-content">
              <div class="modal-header">
                  <div class="modal-title">服务器续期</div>
                  <button class="close-btn" onclick="hideRenewalModal()" title="关闭 (ESC)">&times;</button>
              </div>
              <form id="renewalForm">
                  <!-- 第一部分：续期周期设置 -->
                  <div class="renewal-section">
                      <div class="renewal-section-title">
                          <i class="iconfont icon-repeat"></i>
                          <span>续期周期设置</span>
                      </div>
                      <div class="form-group">
                          <label for="renewalNumber">续期周期</label>
                          <div style="display: flex; gap: 8px; align-items: center;">
                              <input type="number" id="renewalNumber" min="1" max="999" required style="flex: 1;" placeholder="请输入数量">
                              <select id="renewalUnit" required style="width: 70px;">
                                  <option value="天">天</option>
                                  <option value="月">月</option>
                                  <option value="年">年</option>
                              </select>
                          </div>
                          <div style="font-size: 12px; color: #95a5a6; margin-top: 4px;">
                              默认显示服务器原有的续期周期，如需修改请重新输入
                          </div>
                      </div>
                  </div>
                  
                  <!-- 第二部分：续期起始日期选择 -->
                  <div class="renewal-section">
                      <div class="renewal-section-title">
                          <i class="iconfont icon-jisuanqi"></i>
                          <span>起始日期计算方式</span>
                      </div>
                      <div class="form-group">
                          <label for="renewalStartType" class="renewal-start-label">续期起始日期</label>
                          <div class="renewal-options-grid">
                              <label class="renewal-option-item">
                                  <input type="radio" name="renewalStartType" id="renewalFromNow" value="now">
                                  <span>从当前日期开始</span>
                              </label>
                              <label class="renewal-option-item">
                                  <input type="radio" name="renewalStartType" id="renewalFromNowAccumulate" value="nowAccumulate" checked>
                                  <span>从当前日期累计</span>
                              </label>
                              <label class="renewal-option-item">
                                  <input type="radio" name="renewalStartType" id="renewalFromExpire" value="expire">
                                  <span>从到期日期开始</span>
                              </label>
                              <label class="renewal-option-item">
                                  <input type="radio" name="renewalStartType" id="renewalCustom" value="custom">
                                  <span>自定义</span>
                              </label>
                          </div>
                          <div style="font-size: 12px; color: #95a5a6; margin-top: 4px;">
                              <span id="renewalStartHint">从今天开始 + 续期周期 + 剩余天数（推荐）</span>
                          </div>
                      </div>
                  </div>
                  
                  <!-- 第三部分：日期显示与确认 -->
                  <div class="renewal-section">
                      <div class="renewal-section-title">
                          <i class="iconfont icon-calendar-days"></i>
                          <span id="renewalDateSectionTitle">到期日期预览</span>
                      </div>
                      <div class="form-group">
                          <label for="currentExpireDate" id="currentExpireDateLabel">当前到期日期</label>
                          <input type="date" id="currentExpireDate" class="renewal-date-input" readonly>
                      </div>
                      
                      <div class="form-group">
                          <label for="newExpireDate">续期后到期日期</label>
                          <input type="date" id="newExpireDate" class="renewal-date-input renewal-success" readonly>
                      </div>
                  </div>
                  
                  <div class="form-actions">
                      <button type="button" class="btn btn-secondary" onclick="hideRenewalModal()">取消</button>
                      <button type="submit" class="btn btn-primary">确认续期</button>
                  </div>
              </form>
          </div>
      </div>

      <!-- 自定义确认对话框 -->
      <div class="confirm-overlay" id="confirmOverlay">
          <div class="confirm-dialog">
              <div class="confirm-icon" id="confirmIcon">⚠️</div>
              <div class="confirm-title" id="confirmTitle">确认操作</div>
              <div class="confirm-message" id="confirmMessage">您确定要执行此操作吗？</div>
              <div class="confirm-actions">
                  <button class="confirm-btn confirm-btn-secondary" onclick="hideConfirmDialog()">取消</button>
                  <button class="confirm-btn confirm-btn-primary" id="confirmOkBtn" onclick="confirmOkAction()">确定</button>
              </div>
          </div>
      </div>
      
      <!-- Footer -->
      <footer class="footer">
          <div class="footer-content">
              <span class="footer-text">Copyright © 2025 Faiz</span>
              <span class="footer-divider">|</span>
              <a href="https://github.com/kamanfaiz/CF-Server-AutoCheck" class="footer-link" target="_blank">
                  <i class="iconfont icon-github"></i>
                  GitHub Repository
              </a>
              <span class="footer-divider">|</span>
              <a href="https://blog.faiz.hidns.co" class="footer-link">
                  <i class="iconfont icon-book"></i>
                  Faiz博客
              </a>
          </div>
      </footer>
  
      <script>
          // 全局变量
          let servers = [];
          let categories = [];
          const backgroundImageUrl = \`${DESKTOP_BACKGROUND}\`;
          const mobileBackgroundImageUrl = \`${MOBILE_BACKGROUND}\`;
          
          // 获取自定义背景图URL
          async function getCustomBackgroundUrl(isMobile = false) {
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  if (isMobile) {
                      return settings.customMobileBackgroundUrl || '';
                  } else {
                      return settings.customDesktopBackgroundUrl || '';
                  }
              } catch (error) {
                  return '';
              }
          }
          
          // 获取自定义Logo URL
          async function getCustomLogoUrl() {
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  return settings.customLogoUrl || '';
              } catch (error) {
                  return '';
              }
          }
          
          // 检测Logo文件格式并应用相应的CSS类
          function applyLogoStyleByFormat(logoElement, logoUrl) {
              if (!logoElement || !logoUrl) return;
              
              // 移除现有的格式类
              logoElement.classList.remove('svg-logo', 'raster-logo');
              
              // 从URL中提取文件扩展名
              const url = logoUrl.toLowerCase();
              if (url.includes('.svg') || url.includes('format=svg')) {
                  // SVG格式 - 使用滤镜适配主题
                  logoElement.classList.add('svg-logo');
              } else {
                  // 其他格式 (PNG, JPG, WebP等) - 保持原始颜色
                  logoElement.classList.add('raster-logo');
              }
          }
          
          // 排序相关变量
          let currentSortField = 'addTime';
          let currentSortOrder = 'asc';
          
          // 主题切换相关函数
          function toggleTheme() {
              const html = document.documentElement;
              
              // 获取触发事件的按钮（可能是原始按钮或移动端克隆按钮）
              let triggerSwitch = event && event.target;
              let isDark;
              
              // 如果没有event.target，回退到获取主按钮
              if (!triggerSwitch) {
                  triggerSwitch = document.getElementById('theme-switch');
              }
              
              isDark = triggerSwitch.checked;
              
              // 应用主题
              if (isDark) {
                  html.setAttribute('data-theme', 'dark');
                  localStorage.setItem('theme', 'dark');
              } else {
                  html.removeAttribute('data-theme');
                  localStorage.setItem('theme', 'light');
              }
              
              // 同步所有主题切换按钮的状态
              const allThemeSwitches = document.querySelectorAll('#theme-switch, #mobile-theme-switch');
              allThemeSwitches.forEach(switchEl => {
                  if (switchEl && switchEl !== triggerSwitch) {
                      switchEl.checked = isDark;
                  }
              });
              
              // 更新背景图样式，确保覆盖层在主题切换后正确应用
              // 延迟一下以确保DOM属性已经更新
              setTimeout(() => {
                  const backgroundEnabled = getBackgroundEnabled();
                  updateBackgroundStyles(backgroundEnabled);
              }, 10);
              
              // 主题切换后更新标签预览
              setTimeout(() => {
                  updateTagPreview();
                  // 如果编辑模态框开启，也更新编辑预览
                  const editTagInput = document.getElementById('editServerTags');
                  const editTagPreview = document.getElementById('editTagPreview');
                  if (editTagInput && editTagPreview && editTagInput.value.trim()) {
                      const editColorName = document.getElementById('editTagColor').value;
                      const colorValue = getColorValue(editColorName);
                      editTagPreview.style.backgroundColor = colorValue + '20';
                      editTagPreview.style.color = colorValue;
                      editTagPreview.style.borderColor = colorValue + '40';
                  }
              }, 100);
          }
          
          // 初始化主题
          function initTheme() {
              const savedTheme = localStorage.getItem('theme');
              const html = document.documentElement;
              const isDark = savedTheme === 'dark';
              
              if (isDark) {
                  html.setAttribute('data-theme', 'dark');
              } else {
                  html.removeAttribute('data-theme');
              }
              
              // 同步所有主题切换按钮的状态
              const allThemeSwitches = document.querySelectorAll('#theme-switch, #mobile-theme-switch');
              allThemeSwitches.forEach(switchEl => {
                  if (switchEl) {
                      switchEl.checked = isDark;
                  }
              });
          }
          
          // 颜色映射函数：将颜色名称转换为具体颜色值
          function getColorValue(colorName) {
              const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
              const colorMap = {
                  'red': isDark ? '#ff6b6b' : '#dc3545',
                  'orange': '#ffc107', // 橙色在两种模式下都一样
                  'green': isDark ? '#40d962' : '#28a745',
                  'blue': isDark ? '#74c0fc' : '#007BFF',
                  'purple': isDark ? '#be4bdb' : '#9b59b6'
              };
              return colorMap[colorName] || (isDark ? '#74c0fc' : '#007BFF');
          }
          
          // 将旧的颜色值转换为颜色名称
          function getColorName(colorValue) {
              // 如果没有值或为空，返回默认值
              if (!colorValue) return 'blue';
              
              // 如果已经是颜色名称，直接返回
              const validColorNames = ['red', 'orange', 'green', 'blue', 'purple'];
              if (validColorNames.includes(colorValue)) {
                  return colorValue;
              }
              
              // 颜色值映射表（支持大小写不敏感）
              const colorMap = {
                  // 当前系统的颜色值
                  '#dc3545': 'red',
                  '#ff6b6b': 'red',
                  '#ffc107': 'orange',
                  '#28a745': 'green',
                  '#40d962': 'green',
                  '#007BFF': 'blue',
                  '#007bff': 'blue', // 小写版本
                  '#74c0fc': 'blue',
                  '#9b59b6': 'purple',
                  '#be4bdb': 'purple',
                  
                  // 向后兼容旧版本的颜色
                  '#e74c3c': 'red',
                  '#f39c12': 'orange',
                  '#2ecc71': 'green',
                  '#1976d2': 'blue',
                  '#7b1fa2': 'purple',
                  '#388e3c': 'green',
                  '#f57c00': 'orange',
                  '#d32f2f': 'red',
                  '#fbc02d': 'orange',
                  '#ec407a': 'red',
                  '#e91e63': 'red'
              };
              
              // 标准化颜色值（转为小写）
              const normalizedValue = colorValue.toLowerCase();
              return colorMap[normalizedValue] || colorMap[colorValue] || 'blue';
          }
          
          
          // 管理导航栏响应式布局
          function manageNavbarLayout() {
              const navbar = document.querySelector('.navbar');
              const originalThemeToggle = document.querySelector('.nav-actions .theme-toggle-wrapper');
              const isMobile = window.innerWidth <= 768;
              
              // 清理已存在的移动端第二行
              const existingSecondRow = document.querySelector('.mobile-navbar-second-row');
              if (existingSecondRow) {
                  existingSecondRow.remove();
              }
              
              if (isMobile) {
                  // 移动端布局：
                  // 第一行：保留图片开关、系统设置、退出登录按钮，隐藏主题切换
                  // 第二行：只显示主题切换按钮
                  
                  // 创建第二行，只放主题切换按钮
                  const secondRow = document.createElement('div');
                  secondRow.className = 'mobile-navbar-second-row';
                  
                  // 克隆主题切换按钮到第二行
                  if (originalThemeToggle) {
                      const themeToggleClone = originalThemeToggle.cloneNode(true);
                      // 更新克隆元素的ID以避免重复
                      const switchInput = themeToggleClone.querySelector('#theme-switch');
                      if (switchInput) {
                          switchInput.id = 'mobile-theme-switch';
                          switchInput.onchange = toggleTheme;
                          // 同步当前主题状态
                          const originalSwitch = document.getElementById('theme-switch');
                          if (originalSwitch) {
                              switchInput.checked = originalSwitch.checked;
                          }
                      }
                      secondRow.appendChild(themeToggleClone);
                  }
                  
                  navbar.appendChild(secondRow);
                  
                  // 确保新创建的移动端按钮状态正确
                  setTimeout(() => {
                      initTheme();
                  }, 10);
                  
                  // 第一行的操作按钮保持显示，不需要克隆
                  // 通过CSS隐藏第一行的主题切换按钮（在CSS中已经设置了 display: none）
                  
              } else {
                  // 桌面端：所有按钮都在第一行正常显示
                  // 不需要特殊处理，CSS媒体查询会自动处理显示
              }
          }

          // 初始化
          document.addEventListener('DOMContentLoaded', async function() {
              initTheme(); // 初始化主题
              updateCurrentTime();
              setInterval(updateCurrentTime, 1000);
              loadData();
              setupForms();
              manageNavbarLayout(); // 管理导航栏响应式布局
              checkAuthStatus();
              
              // 监听窗口大小变化（添加防抖功能）
              let resizeTimeout;
              window.addEventListener('resize', function() {
                  manageNavbarLayout();
                  // 防抖：更新背景图以适应新的窗口尺寸
                  clearTimeout(resizeTimeout);
                  resizeTimeout = setTimeout(() => {
                      updateBackgroundImage(); // 更新背景图尺寸和切换桌面端/移动端背景图
                  }, 150);
              });
              await initBackground(); // 初始化背景图
              
              // 初始化排序状态（默认按添加时间升序）
              setTimeout(() => {
                  const defaultOption = document.getElementById('check-addTime-asc');
                  if (defaultOption) {
                      defaultOption.parentElement.classList.add('active');
                  }
              }, 100);
          });
          
          // 背景图轮播相关函数

          

          
          async function updateBackgroundImage() {
              // 检查背景图是否被启用
              const isEnabled = getBackgroundEnabled();
              if (!isEnabled) {
                  // 背景图被禁用，清除背景图和相关样式
                  document.body.style.backgroundImage = '';
                  // 重置body背景色，让CSS主题变量生效
                  document.body.style.backgroundColor = '';
                  document.body.style.position = '';
                  document.body.style.minHeight = '';
                  
                  // 移除固定背景容器
                  const bgContainer = document.getElementById('fixed-bg-container');
                  if (bgContainer) {
                      bgContainer.remove();
                  }
                  // 移除覆盖层样式
                  const overlayStyle = document.getElementById('bg-overlay-style');
                  if (overlayStyle) {
                      overlayStyle.remove();
                  }
                  // 确保根据当前主题设置正确的背景色
                  updateBackgroundStyles(false);
                  return;
              }
              
              // 根据屏幕宽度选择背景图
              const isMobile = window.innerWidth <= 768;
              
              // 获取对应平台的自定义背景图URL
              const customBgUrl = await getCustomBackgroundUrl(isMobile);
              const defaultBgUrl = isMobile ? mobileBackgroundImageUrl : backgroundImageUrl;
              const finalBgUrl = customBgUrl || defaultBgUrl;
              
              // 移除可能存在的旧样式（伪元素样式已弃用）
              const existingMobileStyle = document.getElementById('mobile-bg-style');
              if (existingMobileStyle) {
                  existingMobileStyle.remove();
              }
              const existingDesktopStyle = document.getElementById('desktop-bg-style');
              if (existingDesktopStyle) {
                  existingDesktopStyle.remove();
              }
              
              // 设置背景图（优先使用自定义背景图）
              if (finalBgUrl) {
                  // 移除body上的背景设置，改用固定背景容器
                  document.body.style.backgroundImage = '';
                  document.body.style.backgroundColor = 'transparent';
                  document.body.style.position = 'relative';
                  document.body.style.minHeight = '100vh';
                  
                  // 创建或更新固定背景容器
                  let bgContainer = document.getElementById('fixed-bg-container');
                  if (!bgContainer) {
                      bgContainer = document.createElement('div');
                      bgContainer.id = 'fixed-bg-container';
                      document.body.appendChild(bgContainer);
                  }
                  
                  // 设置固定背景容器样式 - 移动端优化
                  const isMobile = window.innerWidth <= 768;
                  
                  if (isMobile) {
                      // 移动端：使用固定视口尺寸，不受页面内容影响
                      bgContainer.style.cssText = \`
                          position: fixed;
                          top: 0;
                          left: 0;
                          width: 100vw;
                          height: 100vh;
                          background-image: url('\${finalBgUrl}');
                          background-size: cover;
                          background-position: center;
                          background-repeat: no-repeat;
                          z-index: -1;
                          pointer-events: none;
                          /* 移动端特殊处理：避免地址栏影响 */
                          min-height: 100vh;
                      \`;
                  } else {
                      // 桌面端：标准fixed布局
                      bgContainer.style.cssText = \`
                          position: fixed;
                          top: 0;
                          left: 0;
                          width: 100vw;
                          height: 100vh;
                          background-image: url('\${finalBgUrl}');
                          background-size: cover;
                          background-position: center;
                          background-repeat: no-repeat;
                          z-index: -1;
                          pointer-events: none;
                      \`;
                  }
                  
                  // 创建深色模式覆盖层样式
                  let overlayStyle = document.getElementById('bg-overlay-style');
                  if (!overlayStyle) {
                      overlayStyle = document.createElement('style');
                      overlayStyle.id = 'bg-overlay-style';
                      document.head.appendChild(overlayStyle);
                  }
                  
                  overlayStyle.textContent = \`
                      #fixed-bg-container::after {
                          content: '';
                          position: absolute;
                          top: 0;
                          left: 0;
                          width: 100%;
                          height: 100%;
                          background: var(--background-overlay);
                          pointer-events: none;
                          z-index: 1;
                      }
                  \`;
                  
                  // 监听窗口大小变化，更新背景容器尺寸
                  const updateBgSize = () => {
                      if (bgContainer) {
                          const isMobile = window.innerWidth <= 768;
                          bgContainer.style.position = 'fixed';
                          bgContainer.style.width = '100vw';
                          bgContainer.style.height = '100vh';
                      }
                  };
                  
                  // 移除可能存在的旧监听器
                  window.removeEventListener('resize', window.bgResizeHandler);
                  // 添加新的监听器
                  window.bgResizeHandler = updateBgSize;
                  window.addEventListener('resize', window.bgResizeHandler);
                  
                  // 更新背景图相关样式
                  updateBackgroundStyles(true);
              }
          }
          
          // 使用传入的设置更新背景图（避免重新从API获取）
          async function updateBackgroundImageWithSettings(settings) {
              // 检查背景图是否被启用
              const isEnabled = getBackgroundEnabled();
              if (!isEnabled) {
                  // 背景图被禁用，清除背景图和相关样式
                  document.body.style.backgroundImage = '';
                  // 重置body背景色，让CSS主题变量生效
                  document.body.style.backgroundColor = '';
                  document.body.style.position = '';
                  document.body.style.minHeight = '';
                  
                  // 移除固定背景容器
                  const bgContainer = document.getElementById('fixed-bg-container');
                  if (bgContainer) {
                      bgContainer.remove();
                  }
                  // 移除覆盖层样式
                  const overlayStyle = document.getElementById('bg-overlay-style');
                  if (overlayStyle) {
                      overlayStyle.remove();
                  }
                  // 确保根据当前主题设置正确的背景色
                  updateBackgroundStyles(false);
                  return;
              }
              
              // 根据屏幕宽度选择背景图
              const isMobile = window.innerWidth <= 768;
              
              // 直接使用传入的设置数据
              const customBgUrl = isMobile ? (settings.customMobileBackgroundUrl || '') : (settings.customDesktopBackgroundUrl || '');
              const defaultBgUrl = isMobile ? mobileBackgroundImageUrl : backgroundImageUrl;
              const finalBgUrl = customBgUrl || defaultBgUrl;
              
              // 移除可能存在的旧样式（伪元素样式已弃用）
              const existingMobileStyle = document.getElementById('mobile-bg-style');
              if (existingMobileStyle) {
                  existingMobileStyle.remove();
              }
              const existingDesktopStyle = document.getElementById('desktop-bg-style');
              if (existingDesktopStyle) {
                  existingDesktopStyle.remove();
              }
              
              // 设置背景图（优先使用自定义背景图）
              if (finalBgUrl) {
                  // 移除body上的背景设置，改用固定背景容器
                  document.body.style.backgroundImage = '';
                  document.body.style.backgroundColor = 'transparent';
                  document.body.style.position = 'relative';
                  document.body.style.minHeight = '100vh';
                  
                  // 创建或更新固定背景容器
                  let bgContainer = document.getElementById('fixed-bg-container');
                  if (!bgContainer) {
                      bgContainer = document.createElement('div');
                      bgContainer.id = 'fixed-bg-container';
                      document.body.appendChild(bgContainer);
                  }
                  
                  // 设置固定背景容器样式 - 移动端优化
                  const isMobile = window.innerWidth <= 768;
                  
                  if (isMobile) {
                      // 移动端：使用固定视口尺寸，不受页面内容影响
                      bgContainer.style.cssText = \`
                          position: fixed;
                          top: 0;
                          left: 0;
                          width: 100vw;
                          height: 100vh;
                          background-image: url('\${finalBgUrl}');
                          background-size: cover;
                          background-position: center;
                          background-repeat: no-repeat;
                          z-index: -2;
                          pointer-events: none;
                          /* 移动端特殊处理：避免地址栏影响 */
                          min-height: 100vh;
                      \`;
                  } else {
                      // 桌面端：标准fixed布局
                      bgContainer.style.cssText = \`
                          position: fixed;
                          top: 0;
                          left: 0;
                          width: 100vw;
                          height: 100vh;
                          background-image: url('\${finalBgUrl}');
                          background-size: cover;
                          background-position: center;
                          background-repeat: no-repeat;
                          z-index: -2;
                          pointer-events: none;
                      \`;
                  }
                  
                  // 添加或更新深色模式覆盖层样式
                  let overlayStyle = document.getElementById('bg-overlay-style');
                  if (!overlayStyle) {
                      overlayStyle = document.createElement('style');
                      overlayStyle.id = 'bg-overlay-style';
                      document.head.appendChild(overlayStyle);
                  }
                  
                  overlayStyle.textContent = \`
                      #fixed-bg-container::after {
                          content: '';
                          position: absolute;
                          top: 0;
                          left: 0;
                          width: 100%;
                          height: 100%;
                          background: var(--background-overlay);
                          pointer-events: none;
                          z-index: 1;
                      }
                  \`;
                  
                  // 监听窗口大小变化，更新背景容器尺寸
                  const updateBgSize = () => {
                      if (bgContainer) {
                          const isMobile = window.innerWidth <= 768;
                          bgContainer.style.position = 'fixed';
                          bgContainer.style.width = '100vw';
                          bgContainer.style.height = '100vh';
                      }
                  };
                  
                  // 移除可能存在的旧监听器
                  window.removeEventListener('resize', window.bgResizeHandler);
                  // 添加新的监听器
                  window.bgResizeHandler = updateBgSize;
                  window.addEventListener('resize', window.bgResizeHandler);
                  
                  // 更新背景图相关样式
                  updateBackgroundStyles(true);
              }
          }
          
          async function initBackground() {
              // 首先更新按钮状态
              updateBackgroundToggleButton();
              
              // 设置固定背景图
              await updateBackgroundImage();
          }
          
          // 背景图开关相关函数
          function getBackgroundEnabled() {
              const stored = localStorage.getItem('background_enabled');
              return stored !== null ? stored === 'true' : true; // 默认开启
          }
          
          function setBackgroundEnabled(enabled) {
              localStorage.setItem('background_enabled', enabled.toString());
          }
          
          function updateBackgroundStyles(enabled) {
              const root = document.documentElement;
              const currentTheme = document.documentElement.getAttribute('data-theme');
              
              if (enabled) {
                  // 启用背景图样式 - 使用透明背景
                  root.style.setProperty('--bg-primary', 'var(--bg-primary-transparent)');
                  root.style.setProperty('--bg-secondary', 'var(--bg-secondary-transparent)');
                  root.style.setProperty('--navbar-bg', 'var(--navbar-bg-transparent)');
                  root.style.setProperty('--footer-bg', 'var(--footer-bg-transparent)');
                  
                  // 深色模式下启用覆盖层
                  if (currentTheme === 'dark') {
                      root.style.setProperty('--background-overlay', 'var(--background-overlay-enabled)');
                  }
              } else {
                  // 禁用背景图样式 - 移除透明背景，恢复正常背景
                  root.style.removeProperty('--bg-primary');
                  root.style.removeProperty('--bg-secondary');
                  root.style.removeProperty('--navbar-bg');
                  root.style.removeProperty('--footer-bg');
                  
                  // 禁用覆盖层
                  root.style.setProperty('--background-overlay', 'transparent');
              }
          }
          
          async function toggleBackgroundImage() {
              const currentState = getBackgroundEnabled();
              const newState = !currentState;
              setBackgroundEnabled(newState);
              
              // 更新按钮状态
              updateBackgroundToggleButton();
              
              // 先更新背景样式，确保主题状态正确
              updateBackgroundStyles(newState);
              
              // 更新背景图显示
              await updateBackgroundImage();
          }
          
          // 处理nezha按钮点击事件
          function handleNezhaClick() {
              openNezhaMonitoring();
          }
          
          // 打开nezha监控网站
          async function openNezhaMonitoring() {
              try {
                  const response = await fetch('/api/settings');
                  if (!response.ok) {
                      throw new Error('获取设置失败');
                  }
                  
                  const settings = await response.json();
                  const nezhaUrl = settings.nezhaMonitorUrl;
                  
                  if (nezhaUrl && nezhaUrl.trim() !== '') {
                      // 在新标签页中打开nezha监控网站
                      window.open(nezhaUrl, '_blank', 'noopener,noreferrer');
                  } else {
                      // 提示用户需要配置URL
                      showNotification('请先在设置中配置哪吒监控网站URL', 'warning');
                  }
              } catch (error) {
                  showNotification('打开哪吒监控失败: ' + error.message, 'error');
              }
          }
          
          function updateBackgroundToggleButton() {
              const btn = document.getElementById('bgToggleBtn');
              if (btn) {
                  const isEnabled = getBackgroundEnabled();
                  if (isEnabled) {
                      btn.classList.add('active');
                      btn.title = '关闭背景图';
                  } else {
                      btn.classList.remove('active');
                      btn.title = '开启背景图';
                  }
              }
          }
          
          // 检查认证状态，决定是否显示登出按钮
          async function checkAuthStatus() {
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  
                  // 如果启用了认证，显示登出按钮
                  if (settings.auth?.enabled) {
                      document.getElementById('logoutBtn').style.display = 'inline-block';
                      // 重新管理导航栏布局，因为退出按钮显示状态发生了变化
                      manageNavbarLayout();
                  }
              } catch (error) {
                  // 静默处理认证状态检查失败
              }
          }
          
          // 排序相关函数
          function toggleSortDropdown() {
              const dropdown = document.getElementById('sortDropdown');
              dropdown.classList.toggle('show');
              
              // 点击外部关闭下拉菜单
              document.addEventListener('click', function closeDropdown(e) {
                  if (!e.target.closest('.sort-dropdown-container')) {
                      dropdown.classList.remove('show');
                      document.removeEventListener('click', closeDropdown);
                  }
              });
          }
          
          // 中文拼音首字母映射函数
          function getChinesePinyin(text) {
              const pinyinMap = {
                  '阿': 'A', '阿里云': 'A',
                  '百': 'B', '搬瓦工': 'B',
                  '腾': 'T', '腾讯云': 'T',
                  '华': 'H', '华为云': 'H',
                  '滴': 'D', 'DigitalOcean': 'D',
                  '谷': 'G', 'Google Cloud': 'G',
                  '微': 'W', '微软': 'W',
                  '亚': 'Y', '亚马逊': 'Y',
                  '火': 'H', '火山引擎': 'H',
                  '金': 'J', '金山云': 'J',
                  '京': 'J', '京东云': 'J',
                  '七': 'Q', '七牛云': 'Q',
                  '又': 'Y', '又拍云': 'Y',
                  '网': 'W', '网易云': 'W',
                  '新': 'X', '新浪云': 'X',
                  '青': 'Q', '青云': 'Q',
                  '美': 'M', '美团云': 'M',
                  '小': 'X', '小鸟云': 'X',
                  '西': 'X', '西部数码': 'X',
                  '景': 'J', '景安网络': 'J',
                  '易': 'Y', '易探云': 'Y',
                  '魅': 'M', '魅族云': 'M',
                  // 常见标签映射
                  '游': 'Y', '游戏': 'Y',
                  '测': 'C', '测试': 'C',
                  '开': 'K', '开发': 'K',
                  '生': 'S', '生产': 'S',
                  '数': 'S', '数据库': 'S',
                  '网': 'W', '网站': 'W',
                  '博': 'B', '博客': 'B',
                  '邮': 'Y', '邮件': 'Y',
                  '监': 'J', '监控': 'J',
                  '备': 'B', '备份': 'B'
              };
              
              // 先检查完整匹配
              if (pinyinMap[text]) {
                  return pinyinMap[text];
              }
              
              // 检查首字符
              const firstChar = text.charAt(0);
              if (pinyinMap[firstChar]) {
                  return pinyinMap[firstChar];
              }
              
              // 如果是英文，直接返回首字母大写
              if (/^[a-zA-Z]/.test(text)) {
                  return text.charAt(0).toUpperCase();
              }
              
              // 其他情况返回原文
              return text;
          }

          // 通用文本排序值获取函数
          function getTextSortValue(text, options = {}) {
              const {
                  removeEmoji = false,
                  handleEmpty = false,
                  applyPinyin = false,
                  sortOrder = 'asc'
              } = options;
              
              // 处理空值
              if (handleEmpty) {
                  const cleanText = text || '';
                  if (!cleanText) {
                      return sortOrder === 'asc' ? '' : 'zzz';
                  }
                  text = cleanText;
              }
              
              // 移除emoji和特殊字符
              if (removeEmoji) {
                  text = text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
              }
              
              // 应用拼音转换
              if (applyPinyin) {
                  text = getChinesePinyin(text);
              }
              
              // 转换为小写
              return text.toLowerCase();
          }

          function setSortOption(field, order) {
              // 移除所有选项的active类
              document.querySelectorAll('.sort-option').forEach(option => {
                  option.classList.remove('active');
              });
              
              // 添加选中状态
              document.getElementById('check-' + field + '-' + order).parentElement.classList.add('active');
              
              // 更新当前排序设置
              currentSortField = field;
              currentSortOrder = order;
              
              // 关闭下拉菜单
              document.getElementById('sortDropdown').classList.remove('show');
              
              // 重新渲染服务器列表
              renderServers();
          }
          
          function sortServers(serversArray) {
              const sortedServers = [...serversArray];
              
              sortedServers.sort((a, b) => {
                  let aValue, bValue;
                  
                  switch (currentSortField) {
                      case 'addTime':
                          // 使用服务器ID作为添加时间的代理（假设ID是递增的）
                          aValue = a.id || 0;
                          bValue = b.id || 0;
                          break;
                      case 'name':
                          // 服务器名称：移除emoji，应用拼音转换，转小写（名称必填，无需处理空值）
                          aValue = getTextSortValue(a.name, { removeEmoji: true, applyPinyin: true });
                          bValue = getTextSortValue(b.name, { removeEmoji: true, applyPinyin: true });
                          break;
                      case 'provider':
                          // 服务商：处理空值，应用拼音转换，转小写
                          aValue = getTextSortValue(a.provider, { 
                              handleEmpty: true, 
                              applyPinyin: true, 
                              sortOrder: currentSortOrder 
                          });
                          bValue = getTextSortValue(b.provider, { 
                              handleEmpty: true, 
                              applyPinyin: true, 
                              sortOrder: currentSortOrder 
                          });
                          break;
                      case 'daysLeft':
                          const today = new Date();
                          const aExpire = new Date(a.expireDate);
                          const bExpire = new Date(b.expireDate);
                          aValue = Math.ceil((aExpire - today) / (1000 * 60 * 60 * 24));
                          bValue = Math.ceil((bExpire - today) / (1000 * 60 * 60 * 24));
                          break;
                      case 'tags':
                          // 标签：处理空值，应用拼音转换，转小写
                          aValue = getTextSortValue(a.tags, { 
                              handleEmpty: true, 
                              applyPinyin: true, 
                              sortOrder: currentSortOrder 
                          });
                          bValue = getTextSortValue(b.tags, { 
                              handleEmpty: true, 
                              applyPinyin: true, 
                              sortOrder: currentSortOrder 
                          });
                          break;
                      default:
                          return 0;
                  }
                  
                  // 处理数字比较
                  if (typeof aValue === 'number' && typeof bValue === 'number') {
                      return currentSortOrder === 'asc' ? aValue - bValue : bValue - aValue;
                  }
                  
                  // 处理字符串比较
                  if (currentSortField === 'name' || currentSortField === 'provider' || currentSortField === 'tags') {
                      // 对于文本排序，特殊处理空值标记
                      if (aValue === '' && bValue === '') return 0;
                      if (aValue === '') return currentSortOrder === 'asc' ? -1 : 1;
                      if (bValue === '') return currentSortOrder === 'asc' ? 1 : -1;
                      if (aValue === 'zzz') return currentSortOrder === 'asc' ? 1 : -1;
                      if (bValue === 'zzz') return currentSortOrder === 'asc' ? -1 : 1;
                  }
                  
                  if (currentSortOrder === 'asc') {
                      return aValue.localeCompare(bValue);
                  } else {
                      return bValue.localeCompare(aValue);
                  }
              });
              
              return sortedServers;
          }
          
          // 更新当前时间
          function updateCurrentTime() {
              const now = new Date();
              const timeString = now.toLocaleTimeString('zh-CN', { 
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
              });
              document.getElementById('currentTime').textContent = timeString;
          }
          
          // 加载数据
          async function loadData() {
              try {
                  await loadServers();
                  await loadCategories();
                  await cleanupOrphanedServers(); // 清理孤儿服务器
                  await loadStats();
                  await initializePageDisplay(); // 初始化页面显示
                  renderServers();
              } catch (error) {
                  // 静默处理数据加载失败
              }
          }
          
          // 初始化页面显示
          async function initializePageDisplay() {
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  updatePageDisplay(settings);
              } catch (error) {
                  // 静默处理页面显示设置加载失败
              }
          }
          
          // 切换设置标签页
          function switchSettingsTab(tabName) {
              // 隐藏所有标签页
              document.querySelectorAll('.settings-tab').forEach(tab => {
                  tab.classList.remove('active');
              });
              
              // 移除所有导航项的激活状态
              document.querySelectorAll('.settings-nav-item').forEach(item => {
                  item.classList.remove('active');
              });
              
              // 显示目标标签页
              document.getElementById(tabName + 'Tab').classList.add('active');
              
              // 激活对应的导航项
              document.getElementById(tabName + 'TabBtn').classList.add('active');
          }
          
          // 清理孤儿服务器（分类已删除但服务器仍引用该分类的情况）
          async function cleanupOrphanedServers() {
              const validCategoryIds = new Set(categories.map(cat => cat.id));
              let hasOrphans = false;
              
              const updatedServers = servers.map(server => {
                  if (server.categoryId && server.categoryId.trim() !== '' && !validCategoryIds.has(server.categoryId)) {
                      hasOrphans = true;
                      return { ...server, categoryId: '' }; // 移动到默认分类
                  }
                  return server;
              });
              
              if (hasOrphans) {
                  servers = updatedServers; // 更新本地数据
                  
                  // 同步到后端
                  try {
                      const response = await fetch('/api/cleanup-servers', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ servers: updatedServers })
                      });
                      
                      if (!response.ok) {
                          // 静默处理后端同步失败
                      }
                  } catch (error) {
                      // 静默处理清理同步失败
                  }
              }
          }
          
          // 显示设置模态框
          async function showSettingsModal() {
              document.getElementById('settingsModal').classList.add('show');
              
              // 重置所有密码输入框为隐藏状态
              resetPasswordVisibility();
              
              await loadSettings();
          }
          
          // 重置密码输入框的显示状态为隐藏
          function resetPasswordVisibility() {
              const passwordInputs = ['loginPassword', 'confirmPassword', 'telegramBotToken', 'telegramChatId'];
              
              passwordInputs.forEach(inputId => {
                  const input = document.getElementById(inputId);
                  const toggleIcon = input?.parentElement?.querySelector('.password-toggle');
                  
                  if (input && toggleIcon) {
                      // 设置为密码类型（隐藏）
                      input.type = 'password';
                      // 设置图标为"不可见"状态
                      toggleIcon.className = 'iconfont icon-bukejian password-toggle';
                  }
              });
          }
          
          // 隐藏设置模态框
          function hideSettingsModal() {
              document.getElementById('settingsModal').classList.remove('show');
              document.getElementById('settingsForm').reset();
          }
          
          // 处理外置Telegram配置
          function handleExternalTelegramConfig(configSource) {
              const externalNotice = document.getElementById('externalConfigNotice');
              const externalText = document.getElementById('externalConfigText');
              const enableCheckbox = document.getElementById('enableTelegramNotification');
              const botTokenInput = document.getElementById('telegramBotToken');
              const chatIdInput = document.getElementById('telegramChatId');
              const botTokenHelp = document.getElementById('botTokenHelp');
              const chatIdHelp = document.getElementById('chatIdHelp');
              
              if (configSource.hasExternal) {
                  // 显示外置配置提示
                  externalNotice.style.display = 'block';
                  
                  // 根据配置来源设置提示文本
                  if (configSource.source === 'environment') {
                      externalText.textContent = '已在Cloudflare环境变量中配置Telegram参数，通知功能已自动启用且不可关闭。';
                  } else if (configSource.source === 'code') {
                      externalText.textContent = '已在代码中配置Telegram参数，通知功能已自动启用且不可关闭。';
                  }
                  
                  // 禁用启用/禁用复选框
                  enableCheckbox.disabled = true;
                  enableCheckbox.checked = true;
                  
                  // 设置输入框为只读并显示提示
                  botTokenInput.placeholder = '已在外置配置中设置';
                  botTokenInput.disabled = true;
                  botTokenInput.style.backgroundColor = '#f5f5f5';
                  botTokenInput.style.color = '#666';
                  
                  chatIdInput.placeholder = '已在外置配置中设置';
                  chatIdInput.disabled = true;
                  chatIdInput.style.backgroundColor = '#f5f5f5';
                  chatIdInput.style.color = '#666';
                  
                  // 更新帮助文本
                  botTokenHelp.textContent = '此参数已在外置配置中设置，无需在此填写';
                  botTokenHelp.style.color = '#666';
                  chatIdHelp.textContent = '此参数已在外置配置中设置，无需在此填写';
                  chatIdHelp.style.color = '#666';
              } else {
                  // 隐藏外置配置提示
                  externalNotice.style.display = 'none';
              }
          }
          
          // 处理外置登录认证配置
          function handleExternalAuthConfig(configSource) {
              const externalNotice = document.getElementById('externalAuthNotice');
              const externalText = document.getElementById('externalAuthText');
              const enableCheckbox = document.getElementById('enableAuth');
              const loginPasswordInput = document.getElementById('loginPassword');
              const confirmPasswordInput = document.getElementById('confirmPassword');
              const loginPasswordHelp = document.getElementById('loginPasswordHelp');
              const confirmPasswordHelp = document.getElementById('confirmPasswordHelp');
              
              if (configSource.hasExternal) {
                  // 显示外置配置提示
                  externalNotice.style.display = 'block';
                  
                  // 根据配置来源设置提示文本
                  if (configSource.source === 'environment') {
                      externalText.textContent = '已在Cloudflare环境变量中配置登录密码，验证功能已自动启用且不可关闭。';
                  } else if (configSource.source === 'code') {
                      externalText.textContent = '已在代码中配置登录密码，验证功能已自动启用且不可关闭。';
                  }
                  
                  // 禁用启用/禁用复选框
                  enableCheckbox.disabled = true;
                  enableCheckbox.checked = true;
                  
                  // 设置输入框为只读并显示提示
                  loginPasswordInput.placeholder = '已在外置配置中设置';
                  loginPasswordInput.disabled = true;
                  loginPasswordInput.style.backgroundColor = '#f5f5f5';
                  loginPasswordInput.style.color = '#666';
                  
                  confirmPasswordInput.placeholder = '已在外置配置中设置';
                  confirmPasswordInput.disabled = true;
                  confirmPasswordInput.style.backgroundColor = '#f5f5f5';
                  confirmPasswordInput.style.color = '#666';
                  
                  // 更新帮助文本
                  loginPasswordHelp.textContent = '此参数已在外置配置中设置，无需在此填写';
                  loginPasswordHelp.style.color = '#666';
                  confirmPasswordHelp.textContent = '此参数已在外置配置中设置，无需在此填写';
                  confirmPasswordHelp.style.color = '#666';
              } else {
                  // 隐藏外置配置提示
                  externalNotice.style.display = 'none';
              }
          }
          
          // 控制Telegram通知配置的启用/禁用
          function toggleTelegramConfig() {
              const enableCheckbox = document.getElementById('enableTelegramNotification');
              const configSection = document.getElementById('telegramConfigSection');
              const botTokenInput = document.getElementById('telegramBotToken');
              const chatIdInput = document.getElementById('telegramChatId');
              const testButton = document.getElementById('testTelegramBtn');
              
              // 如果存在外置配置，跳过常规的启用/禁用逻辑
              if (enableCheckbox.disabled) {
                  return;
              }
              
              const isEnabled = enableCheckbox.checked;
              
              // 控制配置区域的启用/禁用状态
              configSection.style.opacity = isEnabled ? '1' : '0.5';
              botTokenInput.disabled = !isEnabled;
              chatIdInput.disabled = !isEnabled;
              testButton.disabled = !isEnabled;
              
              // 如果禁用，清空输入框
              if (!isEnabled) {
                  botTokenInput.value = '';
                  chatIdInput.value = '';
              }
          }
          
          // 登出函数
          async function logout() {
              const confirmed = await showConfirmDialog(
                  '确认登出',
                  '确定要登出系统吗？',
                  '<i class="iconfont icon-kaimen"></i>',
                  '登出',
                  '取消'
              );
              
              if (confirmed) {
                  // 设置标记表示将要跳转到登录页面
                  sessionStorage.setItem('fromMainPage', 'true');
                  window.location.href = '/logout';
              }
          }
          
          // 切换密码显示/隐藏状态
          function togglePasswordVisibility(inputId) {
              const input = document.getElementById(inputId);
              const toggleIcon = input.parentElement.querySelector('.password-toggle');
              
              if (input.type === 'password') {
                  // 显示密码
                  input.type = 'text';
                  toggleIcon.className = 'iconfont icon-kejian password-toggle';
              } else {
                  // 隐藏密码
                  input.type = 'password';
                  toggleIcon.className = 'iconfont icon-bukejian password-toggle';
              }
          }
          
          // 控制登录验证配置的启用/禁用
          function toggleAuthConfig() {
              const enableCheckbox = document.getElementById('enableAuth');
              const configSection = document.getElementById('authConfigSection');
              const passwordInput = document.getElementById('loginPassword');
              const confirmPasswordInput = document.getElementById('confirmPassword');
              
              // 如果存在外置配置，跳过常规的启用/禁用逻辑
              if (enableCheckbox.disabled) {
                  return;
              }
              
              const isEnabled = enableCheckbox.checked;
              
              // 控制配置区域的启用/禁用状态
              configSection.style.opacity = isEnabled ? '1' : '0.5';
              passwordInput.disabled = !isEnabled;
              confirmPasswordInput.disabled = !isEnabled;
              
              // 如果禁用，清空输入框
              if (!isEnabled) {
                  passwordInput.value = '';
                  confirmPasswordInput.value = '';
                  // 清除验证样式
                  confirmPasswordInput.classList.remove('input-error', 'input-success');
              }
          }
          
          // 密码确认验证
          function validatePasswordConfirm() {
              const passwordInput = document.getElementById('loginPassword');
              const confirmPasswordInput = document.getElementById('confirmPassword');
              
              if (!passwordInput || !confirmPasswordInput) return;
              
              const password = passwordInput.value;
              const confirmPassword = confirmPasswordInput.value;
              
              // 清除之前的样式
              confirmPasswordInput.classList.remove('input-error', 'input-success');
              
              // 如果确认密码为空，不显示任何样式
              if (!confirmPassword) return;
              
              // 如果密码不一致，显示错误样式
              if (password !== confirmPassword) {
                  confirmPasswordInput.classList.add('input-error');
              } else {
                  // 如果密码一致且不为空，显示成功样式
                  if (password && confirmPassword) {
                      confirmPasswordInput.classList.add('input-success');
                  }
              }
          }
          
          // 初始化密码确认验证事件监听器
          function initPasswordValidation() {
              const passwordInput = document.getElementById('loginPassword');
              const confirmPasswordInput = document.getElementById('confirmPassword');
              
              if (passwordInput && confirmPasswordInput) {
                  // 为登录密码输入框添加input事件监听器
                  passwordInput.addEventListener('input', validatePasswordConfirm);
                  
                  // 为确认密码输入框添加input事件监听器
                  confirmPasswordInput.addEventListener('input', validatePasswordConfirm);
              }
          }
          
          // 加载设置数据
          async function loadSettings() {
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  
                            // 填充表单数据
          document.getElementById('enableTelegramNotification').checked = settings.telegram?.enabled || false;
          document.getElementById('telegramBotToken').value = settings.telegram?.botToken || '';
          document.getElementById('telegramChatId').value = settings.telegram?.chatId || '';
          document.getElementById('globalNotifyDays').value = settings.globalNotifyDays || 14;
          // 只有当用户设置了自定义值时才填充输入框，否则显示placeholder
          document.getElementById('siteTitle').value = (settings.siteTitle && settings.siteTitle !== '服务器到期监控') ? settings.siteTitle : '';
          document.getElementById('welcomeMessage').value = (settings.welcomeMessage && settings.welcomeMessage !== 'Hello!') ? settings.welcomeMessage : '';
          document.getElementById('nezhaMonitorUrl').value = settings.nezhaMonitorUrl || '';
          document.getElementById('customDesktopBackgroundUrl').value = settings.customDesktopBackgroundUrl || '';
          document.getElementById('customMobileBackgroundUrl').value = settings.customMobileBackgroundUrl || '';
          document.getElementById('customLogoUrl').value = settings.customLogoUrl || '';
          
          // 填充认证设置
          document.getElementById('enableAuth').checked = settings.auth?.enabled || false;
          document.getElementById('loginPassword').value = settings.auth?.password || '';
          document.getElementById('confirmPassword').value = settings.auth?.password || '';
          
          // 处理外置配置
          if (settings.telegram?.configSource?.hasExternal) {
              handleExternalTelegramConfig(settings.telegram.configSource);
          }
          
          if (settings.auth?.configSource?.hasExternal) {
              handleExternalAuthConfig(settings.auth.configSource);
          }
          
          // 应用配置的启用/禁用状态
          toggleTelegramConfig();
          toggleAuthConfig();
          
          // 初始化密码确认验证
          initPasswordValidation();
              } catch (error) {
                  // 静默处理设置加载失败
              }
          }
          
          // 测试Telegram通知
          async function testTelegramNotification() {
              const enableCheckbox = document.getElementById('enableTelegramNotification');
              const hasExternalConfig = enableCheckbox.disabled;
              
              if (!enableCheckbox.checked) {
                  showNotification('请先启用Telegram通知功能', 'warning');
                  return;
              }
              
              let botToken, chatId;
              
              if (hasExternalConfig) {
                  // 如果是外置配置，从服务器获取配置
                  try {
                      const response = await fetch('/api/settings');
                      const settings = await response.json();
                      botToken = settings.telegram?.botToken || '';
                      chatId = settings.telegram?.chatId || '';
                  } catch (error) {
                      showNotification('获取配置失败，请重试', 'error');
                      return;
                  }
              } else {
                  // 如果是网页配置，从输入框获取
                  botToken = document.getElementById('telegramBotToken').value.trim();
                  chatId = document.getElementById('telegramChatId').value.trim();
              }
              
              if (!botToken || !chatId) {
                  showNotification('Telegram配置不完整，无法发送测试通知', 'warning');
                  return;
              }
              
              const testBtn = document.getElementById('testTelegramBtn');
              const originalHTML = testBtn.innerHTML;
              testBtn.innerHTML = '<i class="iconfont icon-paper-plane"></i> 发送中...';
              testBtn.disabled = true;
              
              try {
                  const message = \`🧪 VPS监控系统测试通知\\n\\n这是一条测试消息，用于验证Telegram通知配置是否正确。\\n\\n发送时间：\${new Date().toLocaleString('zh-CN')}\`;
                  
                  const telegramUrl = \`https://api.telegram.org/bot\${botToken}/sendMessage\`;
                  const response = await fetch(telegramUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          chat_id: chatId,
                          text: message,
                          parse_mode: 'HTML'
                      })
                  });
                  
                  if (response.ok) {
                      showNotification('测试通知发送成功！请检查您的Telegram。', 'success');
                  } else {
                      const errorData = await response.json();
                      throw new Error(errorData.description || '发送失败');
                  }
              } catch (error) {
                  showNotification('测试通知发送失败：' + (error.message || '网络连接错误'), 'error');
              } finally {
                  testBtn.innerHTML = originalHTML;
                  testBtn.disabled = false;
              }
          }
          
          // 加载服务器数据
          async function loadServers() {
              try {
                  const response = await fetch('/api/servers');
                  servers = await response.json();
              } catch (error) {
                  servers = [];
              }
          }
          
          // 加载分类数据
          async function loadCategories() {
              try {
                  const response = await fetch('/api/categories');
                  categories = await response.json();
                  
                  // 确保分类按sortOrder排序，如果没有sortOrder则按创建顺序
                  categories.sort((a, b) => {
                      const aOrder = a.sortOrder !== undefined ? a.sortOrder : 999;
                      const bOrder = b.sortOrder !== undefined ? b.sortOrder : 999;
                      return aOrder - bOrder;
                  });
                  
                  // 为没有sortOrder的分类设置默认值
                  categories.forEach((category, index) => {
                      if (category.sortOrder === undefined) {
                          category.sortOrder = index;
                      }
                  });
              } catch (error) {
                  categories = [];
              }
          }
          
          // 加载统计数据
          async function loadStats() {
              try {
                  const response = await fetch('/api/stats');
                  const stats = await response.json();
                  
                  document.getElementById('totalServers').innerHTML = 
                      \`<span class="status-indicator online"></span>\${stats.totalServers}\`;
                  document.getElementById('onlineServers').innerHTML = 
                      \`<span class="status-indicator online"></span>\${stats.onlineServers}\`;
                  document.getElementById('offlineServers').innerHTML = 
                      \`<span class="status-indicator offline"></span>\${stats.offlineServers}\`;
                  document.getElementById('expiringSoon').innerHTML = 
                      \`<span class="status-indicator warning"></span>\${stats.expiringSoon}\`;
              } catch (error) {
                  // 静默处理统计数据加载失败
              }
          }
          
          // 筛选相关变量
          let currentFilter = 'all'; // 当前筛选状态：all, online, warning, offline
          
          // 筛选服务器函数
          function filterServers(filterType) {
              currentFilter = filterType;
              
              // 重新渲染服务器列表
              renderServers();
          }
          
          // 获取服务器状态
          function getServerStatus(server) {
              const now = new Date();
              const expireDate = new Date(server.expireDate);
              const daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
              
              if (daysLeft < 0) {
                  return 'offline'; // 已过期
              } else {
                  // 从续期周期字段获取天数
                  const cycleDays = renewalPeriodToDays(server.renewalPeriod);
                  // 计算50%的阈值，向下取整
                  const halfCycle = Math.floor(cycleDays * 0.5);
                  
                  if (daysLeft <= halfCycle) {
                      return 'warning'; // 即将过期（剩余天数 <= 周期天数的50%）
                  } else {
                      return 'online'; // 正常运行（剩余天数 > 周期天数的50%）
                  }
              }
          }
          
          // 渲染服务器卡片
          function renderServers() {
              const grid = document.getElementById('serversGrid');
              
              if (servers.length === 0 && categories.length === 0) {
                  grid.innerHTML = \`
                      <div class="empty-state">
                          <h3>未找到服务器</h3>
                          <p>请先创建分类，然后在分类中添加服务器</p>
                          <button class="btn btn-primary" onclick="showCategoryModal()"><i class="iconfont icon-fenlei"></i> 创建分类</button>
                      </div>
                  \`;
                  return;
              }
              
              // 根据当前筛选条件过滤服务器
              let filteredServers = servers;
              if (currentFilter !== 'all') {
                  filteredServers = servers.filter(server => {
                      const status = getServerStatus(server);
                      return status === currentFilter;
                  });
              }
              
              // 按分类分组服务器
              const serversByCategory = {};
              const uncategorizedServers = [];
              
              // 创建分类ID映射，用于检查分类是否存在
              const validCategoryIds = new Set(categories.map(cat => cat.id));
              
              filteredServers.forEach(server => {
                  // 检查服务器的分类是否存在
                  if (server.categoryId && server.categoryId.trim() !== '' && validCategoryIds.has(server.categoryId)) {
                      // 分类存在，添加到对应分类
                      if (!serversByCategory[server.categoryId]) {
                          serversByCategory[server.categoryId] = [];
                      }
                      serversByCategory[server.categoryId].push(server);
                  } else {
                      // 分类不存在或为空，添加到默认分类
                      uncategorizedServers.push(server);
                  }
              });
              
              // 对每个分类的服务器进行排序
              Object.keys(serversByCategory).forEach(categoryId => {
                  serversByCategory[categoryId] = sortServers(serversByCategory[categoryId]);
              });
              
              // 对默认分类的服务器进行排序
              const sortedUncategorizedServers = sortServers(uncategorizedServers);
              
              let html = '';
              
              // 首先渲染默认分类（无分类的服务器）
              if (sortedUncategorizedServers.length > 0 || (categories.length === 0 && currentFilter === 'all')) {
                  let defaultContent = '';
                  if (sortedUncategorizedServers.length > 0) {
                      defaultContent = \`
                          <div class="category-servers">
                              \${sortedUncategorizedServers.map(server => renderServerCard(server)).join('')}
                          </div>
                      \`;
                  } else {
                      defaultContent = \`
                          <div class="empty-category">
                              <p style="color: #95a5a6; text-align: center; padding: 40px 20px; font-style: italic;">
                                  默认分类下暂无服务器<br>
                                  <button class="btn btn-primary" onclick="showAddServerModal()" style="margin-top: 12px; font-size: 12px; padding: 6px 12px;">
                                      <i class="iconfont icon-jia1"></i> 添加
                                  </button>
                              </p>
                          </div>
                      \`;
                  }
                  
                  html += \`
                      <div class="category-section">
                          <div class="category-header">
                              <div class="category-title-section">
                                  <input type="checkbox" class="category-select-all" data-category-id="" onchange="toggleSelectAll('')" title="全选/取消全选">
                              <h4 class="category-title"><i class="iconfont icon-morenfenlei"></i> 默认分类</h4>
                              <span class="category-count">(\${uncategorizedServers.length})</span>
                              </div>
                              <div class="category-actions">
                                  <button class="action-btn danger" onclick="batchDeleteServers('')" title="批量删除选中的服务器" id="batchDeleteBtn-" style="display: none;"><i class="iconfont icon-shanchu"></i> 删除选中 (<span id="selectedCount-">0</span>)</button>
                                  <button class="action-btn primary" onclick="showAddServerModal('')" title="添加服务器到默认分类"><i class="iconfont icon-jia1"></i> 添加</button>
                              </div>
                          </div>
                          \${defaultContent}
                      </div>
                  \`;
              }
              
              // 然后渲染有服务器的自定义分类
              categories.forEach(category => {
                  const categoryServers = serversByCategory[category.id] || [];
                  
                  // 如果当前是筛选状态且该分类下没有符合条件的服务器，则跳过渲染
                  if (currentFilter !== 'all' && categoryServers.length === 0) {
                      return;
                  }
                  
                  let categoryContent = '';
                  
                  if (categoryServers.length > 0) {
                      categoryContent = \`
                          <div class="category-servers">
                              \${categoryServers.map(server => renderServerCard(server)).join('')}
                          </div>
                      \`;
                  } else {
                      // 只有在显示所有服务器时才显示空分类的提示
                      categoryContent = \`
                          <div class="empty-category">
                              <p style="color: #95a5a6; text-align: center; padding: 40px 20px; font-style: italic;">
                                  该分类下暂无服务器<br>
                                  <button class="btn btn-primary" onclick="showAddServerModal('\${category.id}')" style="margin-top: 12px; font-size: 12px; padding: 6px 12px;">
                                      <i class="iconfont icon-jia1"></i> 添加
                                  </button>
                              </p>
                          </div>
                      \`;
                  }
                  
                  html += \`
                      <div class="category-section">
                          <div class="category-header">
                              <div class="category-title-section">
                                  <input type="checkbox" class="category-select-all" data-category-id="\${category.id}" onchange="toggleSelectAll('\${category.id}')" title="全选/取消全选">
                              <h4 class="category-title"><i class="iconfont icon-folder-open"></i> \${category.name}</h4>
                              <span class="category-count">(\${categoryServers.length})</span>
                              </div>
                              <div class="category-actions">
                                  <button class="action-btn danger" onclick="batchDeleteServers('\${category.id}')" title="批量删除选中的服务器" id="batchDeleteBtn-\${category.id}" style="display: none;"><i class="iconfont icon-shanchu"></i> 删除选中 (<span id="selectedCount-\${category.id}">0</span>)</button>
                                  <button class="action-btn primary" onclick="showAddServerModal('\${category.id}')" title="添加服务器到此分类"><i class="iconfont icon-jia1"></i> 添加</button>
                                  <button class="action-btn danger" onclick="deleteCategory('\${category.id}')" title="删除分类"><i class="iconfont icon-xmark"></i> 删除</button>
                              </div>
                          </div>
                          \${categoryContent}
                      </div>
                  \`;
              });
              
              grid.innerHTML = html;
              
              // 更新选中状态UI
              setTimeout(() => {
                  updateSelectionUI();
              }, 50);
          }
          

          
          // 渲染单个服务器卡片
          function renderServerCard(server) {
              const today = new Date();
              const expireDate = new Date(server.expireDate);
              const daysLeft = Math.ceil((expireDate - today) / (1000 * 60 * 60 * 24));
              
              // 格式化价格显示
              function formatPrice(server) {
                  if (server.price) {
                      return server.price;
                  }
                  return '未设置';
              }
              
              // 格式化日期
              function formatDate(dateString) {
                  if (!dateString) return '未设置';
                  const date = new Date(dateString);
                  const year = date.getFullYear();
                  const month = String(date.getMonth() + 1).padStart(2, '0');
                  const day = String(date.getDate()).padStart(2, '0');
                  return \`\${year}-\${month}-\${day}\`;
              }
              
              // 计算状态类名
              let daysClass = 'normal';
              let statusText = '天后到期';
              
              if (daysLeft < 0) {
                  daysClass = 'expired';
                  statusText = '已过期';
              } else {
                  // 从续期周期字段获取天数
                  const cycleDays = renewalPeriodToDays(server.renewalPeriod);
                  // 计算50%的阈值，向下取整
                  const halfCycle = Math.floor(cycleDays * 0.5);
                  
                  if (daysLeft <= halfCycle) {
                      daysClass = 'warning';  // 黄色：即将过期
                  } else {
                      daysClass = 'normal';   // 绿色：正常运行
                  }
              }
              
              // 检查是否已选中
              const isSelected = selectedServers.has(server.id);
              const selectedClass = isSelected ? ' selected' : '';
              
              return \`
                  <div class="server-card\${selectedClass}">
                      <!-- 卡片头部 - 复选框和服务器名称 -->
                      <div class="monitor-card-header">
                          <div class="monitor-title-section">
                              <input type="checkbox" class="monitor-card-checkbox" data-server-id="\${server.id}"\${isSelected ? ' checked' : ''}>
                              <div class="server-name-container">
                                  <h3 class="monitor-vps-title" onclick="editServer('\${server.id}')" title="点击编辑服务器信息" style="font-weight: bold;">
                                  \${server.name}
                                  </h3>
                                  <i class="iconfont icon-ic_line_copy24px server-name-copy-btn" onclick="copyServerInfo('\${server.id}')" title="复制服务器信息"></i>
                              </div>
                          </div>
                      </div>
                      
                      <!-- 卡片内容 -->
                      <div class="monitor-card-content">
                          <div class="monitor-info-section">
                              <div class="monitor-info-item">
                                  <span style="color: var(--text-secondary);">服务厂商：\${server.provider || '未设置'}</span>
                          </div>
                              <div class="monitor-info-item">
                                  <span style="color: var(--text-secondary);">注册日期：\${formatDate(server.registerDate)}</span>
                          </div>
                              <div class="monitor-info-item">
                                  <span style="color: var(--text-secondary);">上次续期：\${server.lastRenewalDate ? formatDate(server.lastRenewalDate) : '-'}</span>
                          </div>
                              <div class="monitor-info-item">
                                  <span style="color: var(--text-secondary);">下次续期：\${formatDate(server.expireDate)}</span>
                              </div>
                              <div class="monitor-info-item">
                                  <span style="color: var(--text-secondary);">续期周期：\${server.renewalPeriod || '未设置'}</span>
                          </div>
                              <div class="monitor-info-item">
                                  <span style="color: var(--text-secondary);">续期价格：\${formatPrice(server)}</span>
                      </div>
                      </div>
                          <div class="monitor-right-section">
                              <div class="monitor-days-display">
                                  <div class="monitor-days-number \${daysClass}">
                                      \${Math.abs(daysLeft)}
                              </div>
                                  <span class="monitor-days-label">\${statusText}</span>
                          </div>
                              <div class="monitor-notification-info">
                                  <span class="notification-days-label">提前\${server.notifyDays || 14}天通知</span>
                              </div>
                              <div class="monitor-actions">
                                  <button class="monitor-action-btn" onclick="testNotification('\${server.id}', '\${server.name}')" title="测试通知">
                                      <i class="iconfont icon-telegram"></i>
                                  </button>
                                  <button class="monitor-action-btn" onclick="openRenewalLink('\${server.id}')" title="访问续期链接" \${!server.renewalLink ? 'disabled' : ''}>
                                      <i class="iconfont icon-lianjie"></i>
                                  </button>
                                  <button class="monitor-action-btn" onclick="showRenewalModal('\${server.id}')" title="续期">
                                      <i class="iconfont icon-gengxin"></i>
                                  </button>
                              </div>
                          </div>
                      </div>

                      <!-- 卡片底部 -->
                      <div class="monitor-card-footer">
                          <div class="monitor-team-section">
                              <div class="ip-label-container">
                                  <span class="monitor-team-label">IP地址</span>
                                  \${server.ip && server.ip !== '未设置' ? \`<i class="iconfont icon-ic_line_copy24px ip-copy-btn" onclick="copyIPAddress('\${server.ip}')" title="复制IP地址"></i>\` : ''}
                              </div>
                              <span class="monitor-ip-address">\${server.ip || '未设置'}</span>
                          </div>
                          <div class="monitor-server-type">
                              \${server.tags ? (() => {
                                  const colorName = getColorName(server.tagColor) || 'blue';
                                  const colorValue = getColorValue(colorName);
                                  return \`<span class="server-type-badge" style="background-color: \${colorValue}20; color: \${colorValue}; border-color: \${colorValue}40;"><i class="iconfont icon-tags"></i>\${server.tags}</span>\`;
                              })() : ''}
                          </div>
                      </div>
                  </div>
              \`;
          }
          
          // 显示添加服务器模态框
          let currentCategoryId = '';
          async function showAddServerModal(preSelectedCategoryId = '') {
              document.getElementById('addServerModal').classList.add('show');
              currentCategoryId = preSelectedCategoryId;
              
              // 清除服务器名称输入框的验证状态样式
              const serverNameInput = document.getElementById('serverName');
              if (serverNameInput) {
                  serverNameInput.classList.remove('input-error', 'input-success');
              }
              
              // 加载分类选项
              await loadCategoryOptions();
              
              // 设置预选分类
              if (preSelectedCategoryId) {
                  document.getElementById('serverCategory').value = preSelectedCategoryId;
              }
              
              // 加载全局设置并设置默认通知天数
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  const defaultNotifyDays = settings.globalNotifyDays || 14;
                  document.getElementById('notifyDays').value = defaultNotifyDays;
              } catch (error) {
                  document.getElementById('notifyDays').value = 14; // 使用硬编码默认值
              }
          }
          
          // 加载分类选项到下拉菜单
          async function loadCategoryOptions() {
              try {
                  const response = await fetch('/api/categories');
                  const categories = await response.json();
                  
                  const categorySelect = document.getElementById('serverCategory');
                  categorySelect.innerHTML = '<option value="">默认分类</option>';
                  
                  categories.forEach(category => {
                      const option = document.createElement('option');
                      option.value = category.id;
                      option.textContent = category.name;
                      categorySelect.appendChild(option);
                  });
              } catch (error) {
                  // 静默处理分类加载失败
              }
          }
          
          // 隐藏添加服务器模态框
          function hideAddServerModal() {
              document.getElementById('addServerModal').classList.remove('show');
              document.getElementById('addServerForm').reset();
              
              // 清除服务器名称输入框的验证状态样式
              const serverNameInput = document.getElementById('serverName');
              if (serverNameInput) {
                  serverNameInput.classList.remove('input-error', 'input-success');
              }
              
              // 重置服务商选择状态
              resetProviderState();
              // 重置标签选择状态
              resetTagState();
              currentCategoryId = ''; // 重置分类ID
          }
          



          
          // 重置服务商选择状态
          function resetProviderState() {
              const providerSelect = document.getElementById('serverProvider');
              const customInput = document.getElementById('customProvider');
              const backButton = document.getElementById('backToSelect');
              
              // 显示选择框，隐藏输入框和返回按钮
              providerSelect.style.display = 'block';
              customInput.style.display = 'none';
              backButton.style.display = 'none';
              
              // 清空值
              providerSelect.value = '';
              customInput.value = '';
          }
          
          // 重置标签选择状态
          function resetTagState() {
              // 清空标签文本
              document.getElementById('serverTags').value = '';
              
              // 重置到默认颜色
              selectTagColor('red');
              
              // 隐藏预览
              document.getElementById('tagPreview').style.display = 'none';
          }
          
          
          // 显示分类管理模态框
          function showCategoryModal() {
              document.getElementById('categoryModal').classList.add('show');
              renderCategoryList();
          }
          
          // 隐藏分类管理模态框
          function hideCategoryModal() {
              document.getElementById('categoryModal').classList.remove('show');
              document.getElementById('addCategoryForm').reset();
          }
          
          // HTML转义函数
          function escapeHtml(text) {
              const div = document.createElement('div');
              div.textContent = text;
              return div.innerHTML;
          }
          
          // 渲染分类列表
          function renderCategoryList() {
              const container = document.getElementById('categoryList');
              
              if (categories.length === 0) {
                  container.innerHTML = '<p style="color: #95a5a6; text-align: center;">暂无分类</p>';
                  return;
              }
              
              container.innerHTML = categories.map(category => {
                  const isEditing = category.isEditing || false;
                  
                  if (isEditing) {
                      return \`
                          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid var(--primary-color); border-radius: 8px; margin-bottom: 8px; background: var(--bg-secondary);">
                              <div style="flex: 1; margin-right: 12px;">
                                  <input type="text" id="edit-name-\${category.id}" value="\${escapeHtml(category.name)}" 
                                         style="width: 100%; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 4px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; background: var(--bg-primary);">
                                  <input type="text" id="edit-desc-\${category.id}" value="\${escapeHtml(category.description || '')}" 
                                         placeholder="分类描述（可选）"
                                         style="width: 100%; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 12px; color: var(--text-secondary); background: var(--bg-primary);">
                              </div>
                              <div style="display: flex; gap: 8px;">
                                  <button class="action-btn primary" onclick="saveCategory('\${category.id}')"><i class="iconfont icon-check"></i> 保存</button>
                                  <button class="action-btn secondary" onclick="cancelEdit('\${category.id}')"><i class="iconfont icon-xmark"></i> 取消</button>
                              </div>
                          </div>
                      \`;
                  } else {
                      return \`
                          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; background: var(--bg-primary);">
                              <div>
                                  <div style="font-weight: 600; color: var(--text-primary);">\${category.name}</div>
                                  \${category.description ? \`<div style="font-size: 12px; color: var(--text-secondary);">\${category.description}</div>\` : ''}
                              </div>
                              <div style="display: flex; gap: 8px;">
                                  <button class="action-btn secondary" onclick="moveCategoryUp('\${category.id}')" title="上移分类" \${categories.indexOf(category) === 0 ? 'disabled' : ''}><i class="iconfont icon-shangjiantou1"></i></button>
                                  <button class="action-btn secondary" onclick="moveCategoryDown('\${category.id}')" title="下移分类" \${categories.indexOf(category) === categories.length - 1 ? 'disabled' : ''}><i class="iconfont icon-xiajiantou1"></i></button>
                                  <button class="action-btn primary" onclick="editCategory('\${category.id}')"><i class="iconfont icon-pencil"></i> 编辑</button>
                                  <button class="action-btn danger" onclick="deleteCategory('\${category.id}')"><i class="iconfont icon-xmark"></i> 删除</button>
                              </div>
                          </div>
                      \`;
                  }
              }).join('');
          }
          
          // 选择标签颜色
          function selectTagColor(colorName) {
              // 移除所有颜色按钮的选中状态
              document.querySelectorAll('.color-btn').forEach(btn => {
                  btn.classList.remove('selected');
              });
              
              // 添加选中状态到当前按钮
              const selectedBtn = document.querySelector(\`.tag-color-\${colorName}\`);
              if (selectedBtn) {
                  selectedBtn.classList.add('selected');
              }
              
              // 更新隐藏的颜色值
              const tagColorInput = document.getElementById('tagColor');
              if (tagColorInput) {
                  tagColorInput.value = colorName;
              }
              
              // 更新预览
              updateTagPreview();
          }
          
          // 更新标签预览
          function updateTagPreview() {
              const tagTextInput = document.getElementById('serverTags');
              const tagColorInput = document.getElementById('tagColor');
              const preview = document.getElementById('tagPreview');
              
              if (!tagTextInput || !tagColorInput || !preview) return;
              
              const tagText = tagTextInput.value;
              const tagColorName = tagColorInput.value;
              
              if (tagText.trim()) {
                  preview.innerHTML = '<i class="iconfont icon-tags"></i>' + tagText;
                  // 获取实际颜色值并设置样式
                  const colorValue = getColorValue(tagColorName);
                  preview.style.backgroundColor = colorValue + '20'; // 20% 透明度
                  preview.style.color = colorValue;
                  preview.style.borderColor = colorValue + '40'; // 40% 透明度
                  preview.style.opacity = '1';
                  preview.style.display = 'block';
              } else {
                  preview.style.display = 'none';
              }
          }
          
          // 切换自定义服务商输入框
          function toggleCustomProvider() {
              const providerSelect = document.getElementById('serverProvider');
              const customInput = document.getElementById('customProvider');
              const backButton = document.getElementById('backToSelect');
              
              if (providerSelect.value === '其他') {
                  // 切换到输入模式
                  providerSelect.style.display = 'none';
                  customInput.style.display = 'block';
                  backButton.style.display = 'block';
                  customInput.focus();
              }
          }
          
          // 返回到选择模式
          function backToSelectProvider() {
              const providerSelect = document.getElementById('serverProvider');
              const customInput = document.getElementById('customProvider');
              const backButton = document.getElementById('backToSelect');
              
              // 切换回选择模式
              providerSelect.style.display = 'block';
              customInput.style.display = 'none';
              backButton.style.display = 'none';
              
              // 重置选择
              providerSelect.value = '';
              customInput.value = '';
          }
          
          // 处理自定义输入框失去焦点
          function handleCustomProviderBlur() {
              // 可以在这里添加验证逻辑，现在暂时留空
          }
          
          // 自动计算到期日期
          function calculateExpireDate() {
              const registerDate = document.getElementById('registerDate').value;
              const renewalNum = document.getElementById('renewalPeriodNum').value;
              const renewalUnit = document.getElementById('renewalPeriodUnit').value;
              
              if (registerDate && renewalNum && renewalUnit && parseInt(renewalNum) > 0) {
                  // 使用本地时间避免时区问题
                  const startDate = new Date(registerDate + 'T00:00:00');
                  let expireDate = new Date(startDate);
                  
                  const num = parseInt(renewalNum);
                  
                  switch (renewalUnit) {
                      case '天':
                          expireDate.setDate(expireDate.getDate() + num);
                          break;
                      case '月':
                          // 处理月末日期的特殊情况
                          const originalDay = expireDate.getDate();
                          expireDate.setMonth(expireDate.getMonth() + num);
                          // 如果日期变了（比如从1月31日加1个月变成了3月2日），则设置为目标月的最后一天
                          if (expireDate.getDate() !== originalDay) {
                              expireDate.setDate(0); // 设置为上个月的最后一天
                          }
                          break;
                      case '年':
                          const originalMonth = expireDate.getMonth();
                          const originalDayOfMonth = expireDate.getDate();
                          expireDate.setFullYear(expireDate.getFullYear() + num);
                          // 处理闰年2月29日的情况
                          if (originalMonth === 1 && originalDayOfMonth === 29 && expireDate.getMonth() !== 1) {
                              expireDate.setMonth(1, 28); // 设置为2月28日
                          }
                          break;
                  }
                  
                  // 格式化为YYYY-MM-DD
                  const year = expireDate.getFullYear();
                  const month = String(expireDate.getMonth() + 1).padStart(2, '0');
                  const day = String(expireDate.getDate()).padStart(2, '0');
                  const formattedDate = \`\${year}-\${month}-\${day}\`;
                  
                  document.getElementById('expireDate').value = formattedDate;
              }
          }
          
                        // 设置表单事件
          function setupForms() {
              // 自动计算到期日期的事件监听器
              document.getElementById('registerDate').addEventListener('change', calculateExpireDate);
              document.getElementById('renewalPeriodNum').addEventListener('input', calculateExpireDate);
              document.getElementById('renewalPeriodUnit').addEventListener('change', calculateExpireDate);
              
              // 标签预览的事件监听器
              document.getElementById('serverTags').addEventListener('input', updateTagPreview);
              
              // 初始化标签颜色选择（默认选中第一个颜色）
              selectTagColor('red');
              
              // 检查服务器名称是否重复
              async function checkServerNameDuplicate(name) {
                  try {
                      const nameInput = document.getElementById('serverName');
                      
                      // 清除之前的样式
                      nameInput.classList.remove('input-error', 'input-success');
                      
                      if (!name || name.trim().length === 0) return;
                      
                      const response = await fetch('/api/servers');
                      if (response.ok) {
                          const servers = await response.json();
                          // 直接比较完整名称（包括emoji）
                          const trimmedNewName = name.trim();
                          
                          // 检查名称是否为空
                          if (!trimmedNewName) {
                              nameInput.classList.add('input-error');
                              showNotification('请输入服务器名称', 'warning');
                              return false;
                          }
                          
                          const conflictServer = servers.find(server => {
                              return server.name.trim() === trimmedNewName;
                          });
                          
                          if (conflictServer) {
                              nameInput.classList.add('input-error');
                              showNotification(\`服务器名称已存在，与"\${conflictServer.name}"冲突，请使用不同的名称\`, 'warning');
                              return false; // 返回false表示有重复
                          } else {
                              nameInput.classList.add('input-success');
                              return true; // 返回true表示没有重复
                          }
                      }
                  } catch (error) {
                      // 静默处理服务器名称检查失败
                      return false;
                  }
                            }
              
              // 检查编辑时的服务器名称是否重复（排除当前编辑的服务器）
              async function checkEditServerNameDuplicate(name, currentServerId) {
                  try {
                      const nameInput = document.getElementById('editServerName');
                      
                      // 清除之前的样式
                      nameInput.classList.remove('input-error', 'input-success');
                      
                      if (!name || name.trim().length === 0) return;
                      
                      const response = await fetch('/api/servers');
                      if (response.ok) {
                          const servers = await response.json();
                          // 直接比较完整名称（包括emoji）
                          const trimmedNewName = name.trim();
                          
                          // 检查名称是否为空
                          if (!trimmedNewName) {
                              nameInput.classList.add('input-error');
                              showNotification('请输入服务器名称', 'warning');
                              return false;
                          }
                          
                          // 查找冲突的服务器，但排除当前正在编辑的服务器
                          const conflictServer = servers.find(server => {
                              if (server.id === currentServerId) return false; // 排除当前编辑的服务器
                              return server.name.trim() === trimmedNewName;
                          });
                          
                          if (conflictServer) {
                              nameInput.classList.add('input-error');
                              showNotification('服务器名称已存在，与"' + conflictServer.name + '"冲突，请使用不同的名称', 'warning');
                              return false; // 返回false表示有重复
                          } else {
                              nameInput.classList.add('input-success');
                              return true; // 返回true表示没有重复
                          }
                      }
                  } catch (error) {
                      console.error('检查编辑服务器名称失败:', error);
                      return false;
                  }
              }
              
              // 从剪贴板导入服务器信息
              async function importFromClipboard() {
                  try {
                      let clipboardText = '';
                      
                      if (navigator.clipboard && window.isSecureContext) {
                          // 使用现代Clipboard API
                          clipboardText = await navigator.clipboard.readText();
                      } else {
                          // 降级方案：提示用户手动粘贴
                          clipboardText = prompt('请粘贴服务器信息数据：');
                          if (!clipboardText) {
                              return;
                          }
                      }
                      
                      // 解析JSON数据
                      let serverData;
                      try {
                          serverData = JSON.parse(clipboardText);
                      } catch (parseError) {
                          showNotification('剪贴板数据格式错误，请确保是有效的服务器信息', 'error');
                          return;
                      }
                      
                      // 验证必要字段
                      if (!serverData || typeof serverData !== 'object') {
                          showNotification('无效的服务器数据', 'error');
                          return;
                      }
                      
                      // 填充表单
                      if (serverData.name) document.getElementById('serverName').value = serverData.name;
                      if (serverData.provider) {
                          const providerSelect = document.getElementById('serverProvider');
                          if ([...providerSelect.options].some(option => option.value === serverData.provider)) {
                              providerSelect.value = serverData.provider;
                          } else {
                              // 如果是自定义服务商
                              providerSelect.value = '其他';
                              toggleCustomProvider();
                              document.getElementById('customProvider').value = serverData.provider;
                          }
                      }
                      if (serverData.ip) document.getElementById('serverIP').value = serverData.ip;
                      // 不处理 categoryId，保持用户当前选择的分类
                      if (serverData.tags) {
                          document.getElementById('serverTags').value = serverData.tags;
                          if (serverData.tagColor) {
                              selectTagColor(serverData.tagColor);
                          }
                      }
                      if (serverData.registerDate) document.getElementById('registerDate').value = serverData.registerDate;
                      
                      // 处理续期周期 - 优先使用分离字段，否则解析renewalPeriod
                      if (serverData.renewalPeriodNum && serverData.renewalPeriodUnit) {
                          document.getElementById('renewalPeriodNum').value = serverData.renewalPeriodNum;
                          document.getElementById('renewalPeriodUnit').value = serverData.renewalPeriodUnit;
                      } else if (serverData.renewalPeriod) {
                          // 解析续期周期（兼容旧格式）
                          const periodMatch = serverData.renewalPeriod.match(/^(\\d+)([月年天])$/);
                          if (periodMatch) {
                              document.getElementById('renewalPeriodNum').value = periodMatch[1];
                              document.getElementById('renewalPeriodUnit').value = periodMatch[2];
                          }
                      }
                      if (serverData.expireDate) document.getElementById('expireDate').value = serverData.expireDate;
                      if (serverData.priceCurrency) document.getElementById('priceCurrency').value = serverData.priceCurrency;
                      if (serverData.priceAmount) document.getElementById('priceAmount').value = serverData.priceAmount;
                      if (serverData.priceUnit) document.getElementById('priceUnit').value = serverData.priceUnit;
                      if (serverData.renewalLink) document.getElementById('renewalLink').value = serverData.renewalLink;
                      if (serverData.notifyDays) document.getElementById('notifyDays').value = serverData.notifyDays;
                      
                      showNotification('服务器信息已成功导入到表单', 'success');
                      
                      // 如果粘贴了服务器名称，检查是否存在同名服务器
                      if (serverData.name) {
                          // 延迟一点执行，确保导入成功消息先显示
                          setTimeout(async () => {
                              await checkServerNameDuplicate(serverData.name);
                          }, 100);
                      }
                      
                  } catch (error) {
                      console.error('导入失败:', error);
                      showNotification('从剪贴板导入失败，请检查数据格式', 'error');
                  }
              }
              
              // 绑定粘贴按钮事件
              document.getElementById('importFromClipboardBtn').addEventListener('click', function() {
                  importFromClipboard();
              });

              // 服务器名称实时检查
              let checkNameTimeout;
              document.getElementById('serverName').addEventListener('input', function(e) {
                  clearTimeout(checkNameTimeout);
                  const nameInput = e.target;
                  const name = nameInput.value.trim();
                  
                  // 清除之前的样式
                  nameInput.classList.remove('input-error', 'input-success');
                  
                  if (name.length === 0) return;
                  
                                // 防抖处理，避免频繁请求
              checkNameTimeout = setTimeout(async () => {
                  await checkServerNameDuplicate(name);
              }, 500); // 500ms 防抖延迟
              });
              
              // 编辑服务器名称输入框的实时检测
              let checkEditNameTimeout;
              document.getElementById('editServerName').addEventListener('input', function(e) {
                  // 如果正在初始化编辑表单，跳过检测
                  if (isEditFormInitializing) return;
                  
                  clearTimeout(checkEditNameTimeout);
                  const nameInput = e.target;
                  const name = nameInput.value.trim();
                  
                  // 清除之前的样式
                  nameInput.classList.remove('input-error', 'input-success');
                  
                  if (name.length === 0) return;
                  
                  // 防抖处理，避免频繁请求
                  checkEditNameTimeout = setTimeout(async () => {
                      if (currentEditServerId) {
                          await checkEditServerNameDuplicate(name, currentEditServerId);
                      }
                  }, 500); // 500ms 防抖延迟
              });
              
              // 添加服务器表单
              document.getElementById('addServerForm').addEventListener('submit', async function(e) {
                  e.preventDefault();
                  
                  // 组装价格信息
                  const priceCurrency = document.getElementById('priceCurrency').value;
                  const priceAmount = document.getElementById('priceAmount').value;
                  const priceUnit = document.getElementById('priceUnit').value;
                  const fullPrice = priceAmount ? \`\${priceCurrency === 'CNY' ? '¥' : priceCurrency === 'USD' ? '$' : priceCurrency === 'EUR' ? '€' : '¥'}\${priceAmount}\${priceUnit}\` : '';
                  
                  // 组装续期周期信息
                  const renewalNum = document.getElementById('renewalPeriodNum').value;
                  const renewalUnit = document.getElementById('renewalPeriodUnit').value;
                  const renewalPeriod = renewalNum ? \`\${renewalNum}\${renewalUnit}\` : '';
                  
                  // 获取服务商名称
                  const providerSelect = document.getElementById('serverProvider');
                  const customInput = document.getElementById('customProvider');
                  
                  let finalProvider = '';
                  
                  // 判断当前是选择模式还是输入模式
                  if (customInput.style.display === 'block') {
                      // 输入模式，使用自定义输入的值
                      finalProvider = customInput.value.trim();
                      if (!finalProvider) {
                          showNotification('请输入服务商名称', 'warning');
                          customInput.focus();
                          return;
                      }
                  } else {
                      // 选择模式，使用下拉选择的值
                      finalProvider = providerSelect.value;
                  }
                  
                  const formData = {
                      name: document.getElementById('serverName').value,
                      ip: document.getElementById('serverIP').value,
                      provider: finalProvider,
                      expireDate: document.getElementById('expireDate').value,
                      registerDate: document.getElementById('registerDate').value,
                      price: fullPrice,
                      renewalPeriod: renewalPeriod,
                      originalRenewalPeriod: renewalPeriod, // 保存原始续期周期
                      renewalLink: document.getElementById('renewalLink').value,
                      tags: document.getElementById('serverTags').value,
                      tagColor: document.getElementById('tagColor').value,
                      categoryId: document.getElementById('serverCategory').value || currentCategoryId,
                      notifyDays: parseInt(document.getElementById('notifyDays').value) || 14
                  };
                  
                  try {
                      const response = await fetch('/api/servers', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(formData)
                      });
                      
                      if (response.ok) {
                          showNotification('服务器添加成功！', 'success');
                          hideAddServerModal();
                          await loadData();
                      } else {
                          const errorData = await response.json();
                          if (errorData.code === 'DUPLICATE_NAME' || errorData.code === 'EMPTY_NAME') {
                              showNotification(errorData.error, 'warning');
                              // 聚焦到服务器名称输入框
                              document.getElementById('serverName').focus();
                              document.getElementById('serverName').select();
                          } else {
                              throw new Error(errorData.error || '添加服务器失败');
                          }
                      }
                  } catch (error) {
                      showNotification('错误：' + error.message, 'error');
                  }
              });
              
              // 添加分类表单
              document.getElementById('addCategoryForm').addEventListener('submit', async function(e) {
                  e.preventDefault();
                  
                  const formData = {
                      name: document.getElementById('categoryName').value,
                      description: document.getElementById('categoryDescription').value
                  };
                  
                  try {
                      const response = await fetch('/api/categories', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(formData)
                      });
                      
                      if (response.ok) {
                          showNotification('分类添加成功！', 'success');
                          this.reset();
                          await loadCategories();
                          renderCategoryList();
                          renderServers(); // 重新渲染服务器列表以显示新分类
                      } else {
                          throw new Error('添加分类失败');
                      }
                  } catch (error) {
                      showNotification('错误：' + error.message, 'error');
                  }
              });
              
              // 注释掉点击模态框外部关闭的功能，防止误触
              // document.getElementById('addServerModal').addEventListener('click', function(e) {
              //     if (e.target === this) {
              //         hideAddServerModal();
              //     }
              // });
              
              // document.getElementById('categoryModal').addEventListener('click', function(e) {
              //     if (e.target === this) {
              //         hideCategoryModal();
              //     }
              // });
              
              // 设置表单
              document.getElementById('settingsForm').addEventListener('submit', async function(e) {
                  e.preventDefault();
                  
                  const enableTelegramCheckbox = document.getElementById('enableTelegramNotification');
                  const enableAuthCheckbox = document.getElementById('enableAuth');
                  const hasExternalTelegramConfig = enableTelegramCheckbox.disabled; // 如果复选框被禁用，说明存在外置配置
                  const hasExternalAuthConfig = enableAuthCheckbox.disabled; // 如果复选框被禁用，说明存在外置配置
                  

                  
                  // 获取当前设置以检测密码变化
                  let currentAuthEnabled = false;
                  let currentPassword = '';
                  try {
                      const currentResponse = await fetch('/api/settings');
                      if (currentResponse.ok) {
                          const currentSettings = await currentResponse.json();
                          currentAuthEnabled = currentSettings.auth?.enabled || false;
                          // 只有当认证启用时，当前密码才有意义
                          currentPassword = currentAuthEnabled ? (currentSettings.auth?.password || '') : '';
                      }
                  } catch (error) {
                      console.error('Failed to get current settings:', error);
                  }
                  
                  const formData = {
                      telegram: {
                          enabled: enableTelegramCheckbox.checked,
                          botToken: document.getElementById('telegramBotToken').value.trim(),
                          chatId: document.getElementById('telegramChatId').value.trim()
                      },
                      auth: {
                          enabled: enableAuthCheckbox.checked,
                          password: enableAuthCheckbox.checked ? document.getElementById('loginPassword').value.trim() : ''
                      },
                      globalNotifyDays: parseInt(document.getElementById('globalNotifyDays').value) || 14,
                      siteTitle: document.getElementById('siteTitle').value.trim(),
                      welcomeMessage: document.getElementById('welcomeMessage').value.trim(),
                      nezhaMonitorUrl: document.getElementById('nezhaMonitorUrl').value.trim(),
                      customDesktopBackgroundUrl: document.getElementById('customDesktopBackgroundUrl').value.trim(),
                      customMobileBackgroundUrl: document.getElementById('customMobileBackgroundUrl').value.trim(),
                      customLogoUrl: document.getElementById('customLogoUrl').value.trim()
                  };
                  
                  // 验证Telegram配置：如果启用了Telegram通知且不是外置配置，则必须填写完整配置
                  if (formData.telegram.enabled && !hasExternalTelegramConfig) {
                      const hasToken = formData.telegram.botToken.trim() !== '';
                      const hasChatId = formData.telegram.chatId.trim() !== '';
                      
                      if (!hasToken || !hasChatId) {
                          showNotification('启用Telegram通知后，Bot Token 和 Chat ID 都必须填写', 'warning');
                          return;
                      }
                  }
                  
                  // 验证认证配置：如果启用了登录验证且不是外置配置，则必须设置密码
                  if (formData.auth.enabled && !hasExternalAuthConfig) {
                      const password = document.getElementById('loginPassword').value.trim();
                      const confirmPassword = document.getElementById('confirmPassword').value.trim();
                      
                      if (!password) {
                          showNotification('启用登录验证后，必须设置登录密码', 'warning');
                          return;
                      }
                      
                      if (password !== confirmPassword) {
                          showNotification('两次输入的密码不一致，请重新输入', 'warning');
                          return;
                      }
                      
                      if (password.length < 4) {
                          showNotification('登录密码长度不能少于4位', 'warning');
                          return;
                      }
                  }
                  
                  try {
                      const response = await fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(formData)
                      });
                      
                      if (response.ok) {
                          showNotification('设置保存成功！', 'success');
                          hideSettingsModal();
                          
                          // 立即更新页面显示
                          await updatePageDisplay(formData);
                          
                          // 检查需要执行的认证相关操作
                          const authAction = checkAuthAction(currentAuthEnabled, currentPassword, formData, hasExternalAuthConfig);
                          
                          if (authAction === 'reauth') {
                              // 需要重新登录
                              showNotification('认证设置已更改，请重新登录', 'info');
                              
                              // 延迟跳转，让用户看到成功提示
                              setTimeout(async () => {
                                  // HttpOnly Cookie无法通过JavaScript删除，需要调用服务器API
                                  try {
                                      // 调用登出API清除服务器端的Cookie
                                      const logoutResponse = await fetch('/logout', {
                                          method: 'GET',
                                          credentials: 'same-origin'
                                      });
                                      
                                      if (logoutResponse.ok) {
                                          // 跳转到登录页面
                                          window.location.href = '/';
                                      } else {
                                          window.location.reload(true);
                                      }
                                  } catch (error) {
                                      window.location.reload(true);
                                  }
                              }, 1500);
                          } else if (authAction === 'refresh') {
                              // 需要刷新页面（禁用认证）
                              showNotification('认证已禁用，页面即将刷新', 'info');
                              
                              // 延迟刷新，让用户看到成功提示
                              setTimeout(() => {
                                  window.location.reload();
                              }, 1500);
                          } else {
                              // 正常更新页面显示
                              await updatePageDisplay(formData);
                          }
                      } else {
                          const errorData = await response.json();
                          throw new Error(errorData.error || '保存设置失败');
                      }
                  } catch (error) {
                      showNotification('错误：' + error.message, 'error');
                  }
              });
              
              // 检查是否需要重新登录或刷新页面
              function checkAuthAction(currentAuthEnabled, currentPassword, formData, hasExternalAuthConfig) {
                  // 如果使用外置配置，不需要特殊处理
                  if (hasExternalAuthConfig) {
                      return 'none';
                  }
                  
                  const newAuthEnabled = formData.auth.enabled;
                  const newPassword = formData.auth.password;
                  

                  
                  // 情况1：从启用变为禁用 → 刷新页面
                  if (currentAuthEnabled && !newAuthEnabled) {
                      return 'refresh';
                  }
                  
                  // 情况2：从禁用变为启用 → 重新登录（无论密码是否相同）
                  if (!currentAuthEnabled && newAuthEnabled && newPassword) {
                      return 'reauth';
                  }
                  
                  // 情况3：认证保持启用状态，但密码发生了变化 → 重新登录
                  if (currentAuthEnabled && newAuthEnabled && currentPassword && newPassword && currentPassword !== newPassword) {
                      return 'reauth';
                  }
                  return 'none';
              }
              
              // 添加ESC键关闭功能
              document.addEventListener('keydown', function(e) {
                  if (e.key === 'Escape') {
                      // 检查哪个模态框是打开的并关闭它
                      if (document.getElementById('addServerModal').classList.contains('show')) {
                          hideAddServerModal();
                      } else if (document.getElementById('categoryModal').classList.contains('show')) {
                          hideCategoryModal();
                      } else if (document.getElementById('settingsModal').classList.contains('show')) {
                          hideSettingsModal();
                      } else if (document.getElementById('renewalModal').classList.contains('show')) {
                          hideRenewalModal();
                      } else if (document.getElementById('editServerModal').classList.contains('show')) {
                          hideEditServerModal();
                      }
                  }
              });
              
              
              // 续期表单事件监听器
              document.getElementById('renewalNumber').addEventListener('input', function() {
                  if (document.getElementById('renewalCustom').checked) {
                      calculateCustomExpireDate();
                  } else {
                      calculateNewExpireDate();
                  }
              });
              document.getElementById('renewalUnit').addEventListener('change', function() {
                  if (document.getElementById('renewalCustom').checked) {
                      calculateCustomExpireDate();
                  } else {
                      calculateNewExpireDate();
                  }
              });
              document.getElementById('renewalFromExpire').addEventListener('change', function() {
                  updateRenewalStartHint();
                  calculateNewExpireDate();
              });
              document.getElementById('renewalFromNow').addEventListener('change', function() {
                  updateRenewalStartHint();
                  calculateNewExpireDate();
              });
              document.getElementById('renewalFromNowAccumulate').addEventListener('change', function() {
                  updateRenewalStartHint();
                  calculateNewExpireDate();
              });
              document.getElementById('renewalCustom').addEventListener('change', function() {
                  updateRenewalStartHint();
                  // 切换到自定义模式时，计算一次初始的到期日期
                  calculateCustomExpireDate();
              });
              
              // 在自定义模式下，监听当前到期日期的变化
              document.getElementById('currentExpireDate').addEventListener('change', function() {
                  if (document.getElementById('renewalCustom').checked) {
                      calculateCustomExpireDate();
                  }
              });
              
              // 在自定义模式下，监听续期后到期日期的变化（反向计算续期周期）
              document.getElementById('newExpireDate').addEventListener('change', function() {
                  if (document.getElementById('renewalCustom').checked) {
                      calculateRenewalPeriodFromDates();
                  }
              });
              
              document.getElementById('renewalForm').addEventListener('submit', async function(e) {
                  e.preventDefault();
                  
                  const renewalNumber = parseInt(document.getElementById('renewalNumber').value);
                  const renewalUnit = document.getElementById('renewalUnit').value;
                  const newExpireDate = document.getElementById('newExpireDate').value;
                  
                  if (!renewalNumber || !renewalUnit || !newExpireDate || renewalNumber <= 0) {
                      showNotification('请输入有效的续期周期', 'warning');
                      return;
                  }
                  
                  await processRenewal(currentRenewalServerId, newExpireDate, renewalNumber, renewalUnit);
              });
              
              // 编辑表单事件监听器
              document.getElementById('editRegisterDate').addEventListener('change', calculateEditExpireDate);
              document.getElementById('editRenewalPeriodNum').addEventListener('input', calculateEditExpireDate);
              document.getElementById('editRenewalPeriodUnit').addEventListener('change', calculateEditExpireDate);
              document.getElementById('editServerTags').addEventListener('input', function() {
                  const tagInput = this;
                  const tagPreview = document.getElementById('editTagPreview');
                  const tagColor = document.getElementById('editTagColor').value;
                  
                  if (tagInput.value.trim()) {
                      tagPreview.innerHTML = '<i class="iconfont icon-tags"></i>' + tagInput.value.trim();
                      // 使用与卡片一致的透明背景样式
                      tagPreview.style.backgroundColor = tagColor + '20'; // 20% 透明度
                      tagPreview.style.color = tagColor;
                      tagPreview.style.borderColor = tagColor + '40'; // 40% 透明度
                      tagPreview.style.display = 'block';
                  } else {
                      tagPreview.style.display = 'none';
                  }
              });
              
              // 编辑服务器表单提交
              document.getElementById('editServerForm').addEventListener('submit', async function(e) {
                  e.preventDefault();
                  
                  if (!currentEditServerId) {
                      showNotification('服务器ID未找到', 'error');
                      return;
                  }
                  
                  // 组装价格信息
                  const priceCurrency = document.getElementById('editPriceCurrency').value;
                  const priceAmount = document.getElementById('editPriceAmount').value;
                  const priceUnit = document.getElementById('editPriceUnit').value;
                  const fullPrice = priceAmount ? \`\${priceCurrency === 'CNY' ? '¥' : priceCurrency === 'USD' ? '$' : priceCurrency === 'EUR' ? '€' : '¥'}\${priceAmount}\${priceUnit}\` : '';
                  
                  // 组装续期周期信息
                  const renewalNum = document.getElementById('editRenewalPeriodNum').value;
                  const renewalUnit = document.getElementById('editRenewalPeriodUnit').value;
                  let renewalPeriod = renewalNum ? \`\${renewalNum}\${renewalUnit}\` : '';
                  
                  // 获取服务商名称
                  const providerSelect = document.getElementById('editServerProvider');
                  const customInput = document.getElementById('editCustomProvider');
                  
                  let finalProvider = '';
                  
                  // 判断当前是选择模式还是输入模式
                  if (customInput.style.display === 'block') {
                      // 输入模式，使用自定义输入的值
                      finalProvider = customInput.value.trim();
                      if (!finalProvider) {
                          showNotification('请输入服务商名称', 'warning');
                          customInput.focus();
                          return;
                      }
                  } else {
                      // 选择模式，使用下拉选择的值
                      finalProvider = providerSelect.value;
                  }
                  
                  // 获取上次续期日期和续期偏好
                  const currentServer = servers.find(s => s.id === currentEditServerId);
                  let lastRenewalDate = currentServer ? currentServer.lastRenewalDate : null;
                  let lastRenewalType = currentServer ? currentServer.lastRenewalType : null;
                  let originalRenewalPeriod = currentServer ? currentServer.originalRenewalPeriod : null;
                  
                  // 如果用户标记了清除，则清除续期记录和偏好，并恢复原始续期周期
                  if (isClearRenewalMarked) {
                      lastRenewalDate = null;
                      lastRenewalType = null;
                      // 恢复原始续期周期（如果有的话）
                      if (originalRenewalPeriod) {
                          renewalPeriod = originalRenewalPeriod;
                      }
                  }
                  
                  const formData = {
                      name: document.getElementById('editServerName').value.trim(),
                      provider: finalProvider,
                      ip: document.getElementById('editServerIP').value.trim(),
                      tags: document.getElementById('editServerTags').value.trim(),
                      tagColor: document.getElementById('editTagColor').value,
                      registerDate: document.getElementById('editRegisterDate').value,
                      expireDate: document.getElementById('editExpireDate').value,
                      renewalPeriod: renewalPeriod,
                      originalRenewalPeriod: originalRenewalPeriod, // 保留原始续期周期（不覆盖）
                      price: fullPrice,
                      renewalLink: document.getElementById('editRenewalLink').value.trim(),
                      notifyDays: parseInt(document.getElementById('editNotifyDays').value) || 14,
                      categoryId: document.getElementById('editServerCategory').value || '',
                      lastRenewalDate: lastRenewalDate, // 如果清除了则为null
                      lastRenewalType: lastRenewalType // 如果清除了则为null
                  };
                  
                  if (!formData.name) {
                      showNotification('请输入服务器名称', 'warning');
                      return;
                  }
                  
                  // 检查服务器名称是否与其他服务器重复
                  const isDuplicateName = await checkEditServerNameDuplicate(formData.name, currentEditServerId);
                  if (isDuplicateName === false) {
                      return; // 如果有重复，停止提交
                  }
                  
                  if (!formData.expireDate) {
                      showNotification('请选择到期时间', 'warning');
                      return;
                  }
                  
                  try {
                      const response = await fetch(\`/api/servers/\${currentEditServerId}\`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(formData)
                      });
                      
                      if (response.ok) {
                          // 重置清除标记
                          isClearRenewalMarked = false;
                          originalServerData = null;
                          
                          showNotification('服务器信息更新成功！', 'success');
                          hideEditServerModal();
                          await loadData();
                      } else {
                          const errorData = await response.json();
                          throw new Error(errorData.error || '更新服务器失败');
                      }
                  } catch (error) {
                      showNotification('错误：' + error.message, 'error');
                  }
              });
          }
          
          // 更新页面显示
          async function updatePageDisplay(settings) {
              // 更新网站标题（如果没有自定义值则使用默认值）
              const siteTitle = settings.siteTitle || '服务器到期监控';
              
              // 直接使用传入的设置数据中的自定义Logo URL，如果没有则使用默认
              const customLogoUrl = settings.customLogoUrl || '';
              const finalLogoUrl = customLogoUrl || '${LOGO_IMAGE_URL}';
              
              const logoElement = document.querySelector('.logo');
              if (logoElement) {
                  // 根据Logo格式确定CSS类
                  const logoClass = finalLogoUrl.toLowerCase().includes('.svg') || finalLogoUrl.toLowerCase().includes('format=svg') ? 'logo-image svg-logo' : 'logo-image raster-logo';
                  logoElement.innerHTML = '<img src="' + finalLogoUrl + '" alt="Logo" class="' + logoClass + '"> ' + siteTitle;
              }
              // 更新页面title
              document.title = siteTitle + ' - 服务器监控面板';
              
              // 更新欢迎语（如果没有自定义值则使用默认值）
              const welcomeMessage = settings.welcomeMessage || 'Hello!';
              const welcomeElement = document.querySelector('.overview-title');
              if (welcomeElement) {
                  welcomeElement.textContent = welcomeMessage;
              }
              
              // 如果背景图开关是开启的，重新应用背景图（这样用户能立即看到自定义背景图的效果）
              if (getBackgroundEnabled()) {
                  await updateBackgroundImageWithSettings(settings);
              }
          }
          
          // 删除服务器
          async function deleteServer(serverId) {
              const server = servers.find(s => s.id === serverId);
              const serverName = server ? server.name : '未知服务器';
              
              const confirmed = await showConfirmDialog(
                  '删除服务器',
                  \`您确定要删除服务器 "\${serverName}" 吗？\\n\\n此操作不可恢复。\`,
                  '<i class="iconfont icon-shanchu"></i>',
                  '删除',
                  '取消'
              );
              
              if (!confirmed) {
                  return;
              }
              
              try {
                  const response = await fetch(\`/api/servers/\${serverId}\`, {
                      method: 'DELETE'
                  });
                  
                  if (response.ok) {
                      await loadData();
                      showNotification('服务器删除成功！', 'success');
                  } else {
                      throw new Error('删除服务器失败');
                  }
              } catch (error) {
                  showNotification('错误：' + error.message, 'error');
              }
          }
          
          // 编辑分类 - 切换到编辑模式
          function editCategory(categoryId) {
              const category = categories.find(c => c.id === categoryId);
              if (!category) {
                  showNotification('分类不存在', 'error');
                  return;
              }
              
              // 先退出其他分类的编辑模式
              categories.forEach(c => c.isEditing = false);
              
              // 设置当前分类为编辑模式
              category.isEditing = true;
              
              // 重新渲染列表
              renderCategoryList();
              
              // 聚焦到名称输入框并添加键盘事件
              setTimeout(() => {
                  const nameInput = document.getElementById(\`edit-name-\${categoryId}\`);
                  const descInput = document.getElementById(\`edit-desc-\${categoryId}\`);
                  
                  if (nameInput) {
                      nameInput.focus();
                      nameInput.select();
                      
                      // 添加键盘事件
                      const handleKeydown = (e) => {
                          if (e.key === 'Enter') {
                              e.preventDefault();
                              saveCategory(categoryId);
                          } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelEdit(categoryId);
                          }
                      };
                      
                      nameInput.addEventListener('keydown', handleKeydown);
                      if (descInput) {
                          descInput.addEventListener('keydown', handleKeydown);
                      }
                  }
              }, 50);
          }
          
          // 保存分类
          async function saveCategory(categoryId) {
              const nameInput = document.getElementById(\`edit-name-\${categoryId}\`);
              const descInput = document.getElementById(\`edit-desc-\${categoryId}\`);
              
              if (!nameInput || !descInput) {
                  showNotification('输入框不存在', 'error');
                  return;
              }
              
              const newName = nameInput.value.trim();
              const newDescription = descInput.value.trim();
              
              if (!newName) {
                  showNotification('分类名称不能为空', 'error');
                  nameInput.focus();
                  return;
              }
              
              try {
                  const response = await fetch(\`/api/categories/\${categoryId}\`, {
                      method: 'PUT',
                      headers: {
                          'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                          name: newName,
                          description: newDescription
                      })
                  });
                  
                  if (response.ok) {
                      // 重新加载所有数据以反映更改
                      await loadCategories();
                      renderCategoryList();
                      
                      // 同时更新主页面的服务器列表和统计数据
                      await loadStats();
                      renderServers();
                      
                      showNotification('分类更新成功！', 'success');
                  } else {
                      const errorData = await response.json();
                      throw new Error(errorData.error || '更新分类失败');
                  }
              } catch (error) {
                  console.error('Save category error:', error);
                  showNotification('错误：' + error.message, 'error');
              }
          }
          
          // 取消编辑
          function cancelEdit(categoryId) {
              const category = categories.find(c => c.id === categoryId);
              if (category) {
                  category.isEditing = false;
                  renderCategoryList();
              }
          }
          
          // 上移分类
          async function moveCategoryUp(categoryId) {
              try {
                  const categoryIndex = categories.findIndex(cat => cat.id === categoryId);
                  if (categoryIndex <= 0) return; // 已经是第一个或未找到
                  
                  // 交换位置
                  [categories[categoryIndex - 1], categories[categoryIndex]] = [categories[categoryIndex], categories[categoryIndex - 1]];
                  
                  // 更新排序值
                  categories.forEach((category, index) => {
                      category.sortOrder = index;
                  });
                  
                  // 保存到服务器
                  await saveCategoriesOrder();
                  
                  // 重新渲染
                  renderCategoryList();
                  renderServers(); // 同时更新主页面的服务器列表
                  
                  showNotification('分类位置已调整', 'success');
              } catch (error) {
                  console.error('上移分类失败:', error);
                  showNotification('上移分类失败', 'error');
              }
          }
          
          // 下移分类
          async function moveCategoryDown(categoryId) {
              try {
                  const categoryIndex = categories.findIndex(cat => cat.id === categoryId);
                  if (categoryIndex === -1 || categoryIndex >= categories.length - 1) return; // 已经是最后一个或未找到
                  
                  // 交换位置
                  [categories[categoryIndex], categories[categoryIndex + 1]] = [categories[categoryIndex + 1], categories[categoryIndex]];
                  
                  // 更新排序值
                  categories.forEach((category, index) => {
                      category.sortOrder = index;
                  });
                  
                  // 保存到服务器
                  await saveCategoriesOrder();
                  
                  // 重新渲染
                  renderCategoryList();
                  renderServers(); // 同时更新主页面的服务器列表
                  
                  showNotification('分类位置已调整', 'success');
              } catch (error) {
                  console.error('下移分类失败:', error);
                  showNotification('下移分类失败', 'error');
              }
          }
          
          // 保存分类排序
          async function saveCategoriesOrder() {
              const response = await fetch('/api/categories/reorder', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ categories: categories.map(cat => ({ id: cat.id, sortOrder: cat.sortOrder })) })
              });
              
              if (!response.ok) {
                  throw new Error('保存分类排序失败');
              }
          }
          
          // 删除分类
          async function deleteCategory(categoryId) {
              const category = categories.find(c => c.id === categoryId);
              const categoryName = category ? category.name : '未知分类';
              
              const confirmed = await showConfirmDialog(
                  '删除分类',
                  \`您确定要删除分类 "\${categoryName}" 吗？\\n\\n删除后该分类下的服务器将移动到默认分类。\`,
                  '<i class="iconfont icon-wenjianjia"></i>',
                  '删除',
                  '取消'
              );
              
              if (!confirmed) {
                  return;
              }
              
              try {
                  const response = await fetch(\`/api/categories/\${categoryId}\`, {
                      method: 'DELETE'
                  });
                  
                  if (response.ok) {
                      // 完全重新加载所有数据
                      await loadData();
                      showNotification('分类删除成功！该分类下的服务器已移动到默认分类。', 'success');
                  } else {
                      const errorData = await response.json();
                      throw new Error(errorData.error || '删除分类失败');
                  }
              } catch (error) {
                  console.error('Delete category error:', error);
                  showNotification('错误：' + error.message, 'error');
              }
          }
          
          // 测试通知
          async function testNotification(serverId, serverName) {
              try {
                  const response = await fetch('/api/settings');
                  const settings = await response.json();
                  
                  if (!settings.telegram || !settings.telegram.botToken || !settings.telegram.chatId) {
                      showNotification('请先在设置中配置Telegram通知参数', 'warning');
                      return;
                  }
                  
                  // 发送测试通知
                  const message = \`🧪 VPS监控系统测试通知\\n\\n服务器：\${serverName}\\n这是一条测试消息，用于验证通知配置是否正确。\\n\\n发送时间：\${new Date().toLocaleString('zh-CN')}\`;
                  
                  const telegramUrl = \`https://api.telegram.org/bot\${settings.telegram.botToken}/sendMessage\`;
                  const telegramResponse = await fetch(telegramUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          chat_id: settings.telegram.chatId,
                          text: message,
                          parse_mode: 'HTML'
                      })
                  });
                  
                  if (telegramResponse.ok) {
                      showNotification('测试通知发送成功！请检查您的Telegram。', 'success');
                  } else {
                      const errorData = await telegramResponse.json();
                      throw new Error(errorData.description || '发送失败');
                  }
              } catch (error) {
                  showNotification('测试通知发送失败：' + error.message, 'error');
              }
          }
          
          // 打开续期链接
          function openRenewalLink(serverId) {
              const server = servers.find(s => s.id === serverId);
              if (!server || !server.renewalLink) {
                  showNotification('该服务器没有设置续期链接', 'warning');
                  return;
              }
              window.open(server.renewalLink, '_blank');
          }
          
          // 复制IP地址
          async function copyIPAddress(ip) {
              try {
                  if (navigator.clipboard && window.isSecureContext) {
                      // 使用现代Clipboard API
                      await navigator.clipboard.writeText(ip);
                  } else {
                      // 降级方案：使用传统方法
                      const textArea = document.createElement('textarea');
                      textArea.value = ip;
                      textArea.style.position = 'fixed';
                      textArea.style.left = '-999999px';
                      textArea.style.top = '-999999px';
                      document.body.appendChild(textArea);
                      textArea.focus();
                      textArea.select();
                      document.execCommand('copy');
                      textArea.remove();
                  }
                  showNotification(\`IP地址 \${ip} 已复制到剪贴板\`, 'success');
              } catch (error) {
                  console.error('复制失败:', error);
                  showNotification('复制失败，请手动复制', 'error');
              }
          }
          
          // 复制服务器完整信息
          async function copyServerInfo(serverId) {
              try {
                  // 确保服务器数据已加载
                  if (!servers || servers.length === 0) {
                      await loadServers();
                  }
                  const server = servers.find(s => s.id === serverId);
                  
                  if (!server) {
                      showNotification('服务器信息未找到', 'error');
                      return;
                  }
                  
                  // 解析价格信息
                  const priceData = parseServerPrice(server.price);
                  let priceCurrency = 'CNY';
                  let priceAmount = '';
                  let priceUnit = '/月';
                  
                  if (priceData) {
                      priceCurrency = priceData.currency;
                      priceAmount = priceData.amount;
                      priceUnit = priceData.unit;
                  }
                  
                  // 解析续期周期信息
                  const renewalData = parseRenewalPeriod(server.renewalPeriod);
                  const renewalPeriodNum = renewalData.number;
                  const renewalPeriodUnit = renewalData.unit;
                  
                  // 构建复制的数据对象（排除id、分类和创建时间等唯一字段）
                  const serverTemplate = {
                      name: server.name,
                      provider: server.provider || '',
                      ip: server.ip || '',
                      // categoryId: 不复制分类信息，让用户在当前分类下添加服务器
                      tags: server.tags || '',
                      tagColor: getColorName(server.tagColor) || 'red',
                      registerDate: server.registerDate || '',
                      renewalPeriod: server.renewalPeriod || '',
                      renewalPeriodNum: renewalPeriodNum,
                      renewalPeriodUnit: renewalPeriodUnit,
                      expireDate: server.expireDate || '',
                      priceCurrency: priceCurrency,
                      priceAmount: priceAmount,
                      priceUnit: priceUnit,
                      renewalLink: server.renewalLink || '',
                      notifyDays: server.notifyDays || 14
                  };
                  
                  // 转换为JSON字符串
                  const serverInfoText = JSON.stringify(serverTemplate, null, 2);
                  
                  if (navigator.clipboard && window.isSecureContext) {
                      // 使用现代Clipboard API
                      await navigator.clipboard.writeText(serverInfoText);
                  } else {
                      // 降级方案：使用传统方法
                      const textArea = document.createElement('textarea');
                      textArea.value = serverInfoText;
                      textArea.style.position = 'fixed';
                      textArea.style.left = '-999999px';
                      textArea.style.top = '-999999px';
                      document.body.appendChild(textArea);
                      textArea.focus();
                      textArea.select();
                      document.execCommand('copy');
                      textArea.remove();
                  }
                  showNotification(\`服务器信息 "\${server.name}" 已复制到剪贴板\`, 'success');
              } catch (error) {
                  console.error('复制失败:', error);
                  showNotification('复制失败，请手动复制', 'error');
              }
          }
          
          // 续期相关函数
          let currentRenewalServerId = '';
          
          // 解析续期周期文本
          function parseRenewalPeriod(renewalPeriod) {
              if (!renewalPeriod) return { number: 1, unit: '月' };
              
              // 直接分析字符串，不使用正则表达式
              let number = '';
              let unitPart = '';
              
              // 分离数字和单位部分
              for (let i = 0; i < renewalPeriod.length; i++) {
                  const char = renewalPeriod[i];
                  const charCode = char.charCodeAt(0);
                  
                  // 如果是数字字符 (0-9)
                  if (charCode >= 48 && charCode <= 57) {
                      number += char;
                  } else {
                      // 其余部分都是单位
                      unitPart = renewalPeriod.substring(i);
                      break;
                  }
              }
              
              const num = parseInt(number) || 1;
              let unit = '';
              
              // 根据字符编码判断单位
              if (unitPart.length > 0) {
                  const firstCharCode = unitPart.charCodeAt(0);
                  
                  if (firstCharCode === 22825) { // "天"
                      unit = '天';
                  } else if (firstCharCode === 26376) { // "月"  
                      unit = '月';
                  } else if (firstCharCode === 24180) { // "年"
                      unit = '年';
                  } else {
                      // 尝试字符串匹配作为备用
                      if (unitPart.includes('天')) unit = '天';
                      else if (unitPart.includes('月')) unit = '月';
                      else if (unitPart.includes('年')) unit = '年';
                      else unit = '月'; // 默认
                  }
              } else {
                  unit = '月'; // 默认
              }
              
              return { number: num, unit };
          }
          
          // 将续期周期转换为天数
          function renewalPeriodToDays(renewalPeriod) {
              if (!renewalPeriod) return 365; // 默认1年
              
              const { number, unit } = parseRenewalPeriod(renewalPeriod);
              
              switch (unit) {
                  case '天':
                      return number;
                  case '月':
                      return number * 30; // 1个月按30天计算
                  case '年':
                      return number * 365; // 1年按365天计算
                  default:
                      return 365; // 默认1年
              }
          }
          
          // 解析服务器价格信息
          function parseServerPrice(priceString) {
              if (!priceString || typeof priceString !== 'string' || priceString.trim() === '') {
                  return null;
              }
              
              const price = priceString.trim();
              let currency = 'CNY';
              let amount = '';
              let unit = '/月';
              
              // 检查货币符号
              const firstChar = price.charAt(0);
              const firstCharCode = price.charCodeAt(0);
              
              // 支持多种¥符号：165(半角¥), 65509(全角￥), 8381(¥)
              if (firstCharCode === 165 || firstCharCode === 65509 || firstCharCode === 8381 || firstChar === '¥') {
                  currency = 'CNY';
                  const remaining = price.substring(1);
                  
                  // 手动解析数字（比正则表达式更可靠）
                  for (let i = 0; i < remaining.length; i++) {
                      const char = remaining.charAt(i);
                      const code = remaining.charCodeAt(i);
                      if (code >= 48 && code <= 57) { // ASCII数字0-9
                          amount += char;
                      } else if (char === '.' && amount.indexOf('.') === -1) {
                          amount += char;
                      } else {
                          break; // 遇到非数字字符停止
                      }
                  }
                  
                  if (amount) {
                      const afterNumber = remaining.substring(amount.length);
                      if (afterNumber) {
                          unit = afterNumber;
                      }
                      return { currency, amount, unit };
                  }
              } else if (firstChar === '$' || firstCharCode === 36) {
                  currency = 'USD';
                  const remaining = price.substring(1);
                  
                  // 手动解析数字
                  for (let i = 0; i < remaining.length; i++) {
                      const char = remaining.charAt(i);
                      const code = remaining.charCodeAt(i);
                      if (code >= 48 && code <= 57) {
                          amount += char;
                      } else if (char === '.' && amount.indexOf('.') === -1) {
                          amount += char;
                      } else {
                          break;
                      }
                  }
                  
                  if (amount) {
                      const afterNumber = remaining.substring(amount.length);
                      if (afterNumber) {
                          unit = afterNumber;
                      }
                      return { currency, amount, unit };
                  }
              } else if (firstChar === '€' || firstCharCode === 8364) {
                  currency = 'EUR';
                  const remaining = price.substring(1);
                  
                  // 手动解析数字
                  for (let i = 0; i < remaining.length; i++) {
                      const char = remaining.charAt(i);
                      const code = remaining.charCodeAt(i);
                      if (code >= 48 && code <= 57) {
                          amount += char;
                      } else if (char === '.' && amount.indexOf('.') === -1) {
                          amount += char;
                      } else {
                          break;
                      }
                  }
                  
                  if (amount) {
                      const afterNumber = remaining.substring(amount.length);
                      if (afterNumber) {
                          unit = afterNumber;
                      }
                      return { currency, amount, unit };
                  }
              } else {
                  // 没有货币符号，默认人民币
                  // 手动解析数字
                  for (let i = 0; i < price.length; i++) {
                      const char = price.charAt(i);
                      const code = price.charCodeAt(i);
                      if (code >= 48 && code <= 57) {
                          amount += char;
                      } else if (char === '.' && amount.indexOf('.') === -1) {
                          amount += char;
                      } else {
                          break;
                      }
                  }
                  
                  if (amount) {
                      const afterNumber = price.substring(amount.length);
                      if (afterNumber) {
                          unit = afterNumber;
                      }
                      return { currency, amount, unit };
                  }
              }
              
              return null;
          }
          
          // 更新续期起始日期的提示文字和当前到期日期显示
          function updateRenewalStartHint() {
              const hintElement = document.getElementById('renewalStartHint');
              const currentExpireDateInput = document.getElementById('currentExpireDate');
              const newExpireDateInput = document.getElementById('newExpireDate');
              const currentExpireDateLabel = document.getElementById('currentExpireDateLabel');
              const sectionTitle = document.getElementById('renewalDateSectionTitle');
              
              if (document.getElementById('renewalCustom').checked) {
                  // 自定义模式
                  hintElement.textContent = '手动编辑到期日期（完全自定义）';
                  currentExpireDateLabel.textContent = '当前到期日期';
                  sectionTitle.textContent = '到期日期设置';
                  
                  // 解除只读限制
                  currentExpireDateInput.removeAttribute('readonly');
                  newExpireDateInput.removeAttribute('readonly');
                  currentExpireDateInput.classList.remove('readonly-date-input');
                  newExpireDateInput.classList.remove('readonly-date-input');
                  
                  // 恢复原始到期日期
                  const server = servers.find(s => s.id === currentRenewalServerId);
                  if (server && server.expireDate) {
                      currentExpireDateInput.value = server.expireDate;
                  }
              } else {
                  // 其他模式都是只读的
                  sectionTitle.textContent = '到期日期预览';
                  currentExpireDateInput.setAttribute('readonly', 'readonly');
                  newExpireDateInput.setAttribute('readonly', 'readonly');
                  currentExpireDateInput.classList.add('readonly-date-input');
                  newExpireDateInput.classList.add('readonly-date-input');
                  
                  if (document.getElementById('renewalFromNow').checked) {
                      hintElement.textContent = '从今天开始 + 续期周期（忽略原到期日期）';
                      // 将当前到期日期显示为今天
                      const today = new Date();
                      currentExpireDateInput.value = today.toISOString().split('T')[0];
                      currentExpireDateLabel.textContent = '起始日期（今天）';
                  } else if (document.getElementById('renewalFromNowAccumulate').checked) {
                      hintElement.textContent = '从今天开始 + 续期周期 + 剩余天数（推荐）';
                      // 恢复原始到期日期
                      const server = servers.find(s => s.id === currentRenewalServerId);
                      if (server && server.expireDate) {
                          currentExpireDateInput.value = server.expireDate;
                      }
                      currentExpireDateLabel.textContent = '当前到期日期';
                  } else if (document.getElementById('renewalFromExpire').checked) {
                      hintElement.textContent = '从原到期日期 + 续期周期';
                      // 恢复原始到期日期
                      const server = servers.find(s => s.id === currentRenewalServerId);
                      if (server && server.expireDate) {
                          currentExpireDateInput.value = server.expireDate;
                      }
                      currentExpireDateLabel.textContent = '当前到期日期';
                  }
              }
          }
          
          // 显示续期模态框
          function showRenewalModal(serverId) {
              const server = servers.find(s => s.id === serverId);
              if (!server) {
                  showNotification('服务器未找到', 'error');
                  return;
              }
              
              currentRenewalServerId = serverId;
              
              // 设置当前到期日期
              document.getElementById('currentExpireDate').value = server.expireDate;
              
              // 解析并设置默认续期周期
              const { number, unit } = parseRenewalPeriod(server.renewalPeriod);
              document.getElementById('renewalNumber').value = number;
              document.getElementById('renewalUnit').value = unit;
              
              // 智能选择续期起始日期类型
              // 如果服务器有保存的续期偏好，使用保存的偏好（但排除"自定义"）
              // 如果上次是"自定义"或从未续过期，默认选择"从到期日期开始"
              // 如果续过期但没有偏好，默认选择"从当前日期累计"
              let defaultRenewalType = 'nowAccumulate'; // 默认值
              
              if (server.lastRenewalType && server.lastRenewalType !== 'custom') {
                  // 有保存的偏好且不是"自定义"，使用保存的偏好
                  defaultRenewalType = server.lastRenewalType;
              } else if (!server.lastRenewalDate || server.lastRenewalType === 'custom') {
                  // 从未续过期，或上次是"自定义"，默认选择"从到期日期开始"
                  defaultRenewalType = 'expire';
              }
              
              // 设置单选按钮
              document.getElementById('renewalFromNow').checked = (defaultRenewalType === 'now');
              document.getElementById('renewalFromNowAccumulate').checked = (defaultRenewalType === 'nowAccumulate');
              document.getElementById('renewalFromExpire').checked = (defaultRenewalType === 'expire');
              document.getElementById('renewalCustom').checked = (defaultRenewalType === 'custom');
              
              // 更新提示文字和当前到期日期显示
              updateRenewalStartHint();
              
              // 清空新到期日期，等待用户触发计算
              document.getElementById('newExpireDate').value = '';
              
              // 自动计算一次新的到期日期
              calculateNewExpireDate();
              
              document.getElementById('renewalModal').classList.add('show');
          }
          
          // 隐藏续期模态框
          function hideRenewalModal() {
              document.getElementById('renewalModal').classList.remove('show');
              document.getElementById('renewalForm').reset();
              document.getElementById('renewalNumber').value = '';
              document.getElementById('renewalUnit').value = '月';
              document.getElementById('newExpireDate').value = '';
              currentRenewalServerId = '';
          }
          
          // 防止循环计算的标志
          let isCalculating = false;
          
          // 计算自定义模式下的到期日期
          function calculateCustomExpireDate() {
              if (isCalculating) return; // 防止循环
              
              const renewalNumber = parseInt(document.getElementById('renewalNumber').value);
              const renewalUnit = document.getElementById('renewalUnit').value;
              const currentExpireDate = new Date(document.getElementById('currentExpireDate').value);
              
              if (!renewalNumber || !renewalUnit || !currentExpireDate || renewalNumber <= 0) {
                  document.getElementById('newExpireDate').value = '';
                  return;
              }
              
              isCalculating = true;
              
              // 从用户设置的当前到期日期开始计算
              let newExpireDate = new Date(currentExpireDate);
              
              // 根据续期周期和单位计算新日期
              switch (renewalUnit) {
                  case '天':
                      newExpireDate.setDate(newExpireDate.getDate() + renewalNumber);
                      break;
                  case '月':
                      newExpireDate.setMonth(newExpireDate.getMonth() + renewalNumber);
                      break;
                  case '年':
                      newExpireDate.setFullYear(newExpireDate.getFullYear() + renewalNumber);
                      break;
              }
              
              // 格式化日期为 YYYY-MM-DD
              const formattedDate = newExpireDate.toISOString().split('T')[0];
              document.getElementById('newExpireDate').value = formattedDate;
              
              isCalculating = false;
          }
          
          // 根据两个日期反向计算续期周期
          function calculateRenewalPeriodFromDates() {
              if (isCalculating) return; // 防止循环
              
              const currentExpireDate = new Date(document.getElementById('currentExpireDate').value);
              const newExpireDate = new Date(document.getElementById('newExpireDate').value);
              
              if (!currentExpireDate || !newExpireDate) {
                  return;
              }
              
              // 如果新日期早于或等于当前日期，不计算
              if (newExpireDate <= currentExpireDate) {
                  return;
              }
              
              isCalculating = true;
              
              // 计算两个日期之间的天数差
              const diffTime = newExpireDate - currentExpireDate;
              const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
              
              // 智能判断应该使用什么单位
              let renewalNumber, renewalUnit;
              
              // 计算年数差
              const yearsDiff = newExpireDate.getFullYear() - currentExpireDate.getFullYear();
              const monthsDiff = newExpireDate.getMonth() - currentExpireDate.getMonth();
              const daysDiff = newExpireDate.getDate() - currentExpireDate.getDate();
              
              // 如果是整年数（月和日都相同或只差一天内的误差）
              if (yearsDiff > 0 && Math.abs(monthsDiff) <= 0 && Math.abs(daysDiff) <= 1) {
                  renewalNumber = yearsDiff;
                  renewalUnit = '年';
              }
              // 如果是整月数（年内的月份差，且日期相同或只差一天内的误差）
              else if (yearsDiff === 0 && monthsDiff > 0 && Math.abs(daysDiff) <= 1) {
                  renewalNumber = monthsDiff;
                  renewalUnit = '月';
              }
              // 如果跨年但月数可以整除（比如13个月 = 1年1个月，取月数）
              else if (yearsDiff > 0 || monthsDiff !== 0) {
                  const totalMonths = yearsDiff * 12 + monthsDiff;
                  if (totalMonths > 0 && Math.abs(daysDiff) <= 1) {
                      renewalNumber = totalMonths;
                      renewalUnit = '月';
                  } else {
                      // 无法精确匹配月份，使用天数
                      renewalNumber = diffDays;
                      renewalUnit = '天';
                  }
              }
              // 其他情况使用天数
              else {
                  renewalNumber = diffDays;
                  renewalUnit = '天';
              }
              
              // 更新续期周期输入框
              document.getElementById('renewalNumber').value = renewalNumber;
              document.getElementById('renewalUnit').value = renewalUnit;
              
              isCalculating = false;
          }
          
          // 计算新的到期日期
          function calculateNewExpireDate() {
              const renewalNumber = parseInt(document.getElementById('renewalNumber').value);
              const renewalUnit = document.getElementById('renewalUnit').value;
              const currentExpireDate = new Date(document.getElementById('currentExpireDate').value);
              
              // 获取用户选择的起始日期类型
              const startFromExpire = document.getElementById('renewalFromExpire').checked;
              const startFromNow = document.getElementById('renewalFromNow').checked;
              const startFromNowAccumulate = document.getElementById('renewalFromNowAccumulate').checked;
              const isCustom = document.getElementById('renewalCustom').checked;
              
              // 如果是自定义模式，不自动计算
              if (isCustom) {
                  return;
              }
              
              if (!renewalNumber || !renewalUnit || !currentExpireDate || renewalNumber <= 0) {
                  document.getElementById('newExpireDate').value = '';
                  return;
              }
              
              // 根据用户选择确定起始日期和计算方式
              let newExpireDate;
              
              if (startFromExpire) {
                  // 从到期日期开始
                  newExpireDate = new Date(currentExpireDate);
              } else if (startFromNow) {
                  // 从当前日期开始（直接替换）
                  newExpireDate = new Date();
                  newExpireDate.setHours(0, 0, 0, 0); // 重置时间为当天0点
              } else if (startFromNowAccumulate) {
                  // 从当前日期累计（当前日期 + 续期周期 + 剩余天数）
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const expireDate = new Date(currentExpireDate);
                  
                  // 计算剩余天数（可能为负数，表示已过期）
                  const daysRemaining = Math.ceil((expireDate - today) / (1000 * 60 * 60 * 24));
                  
                  // 先从当前日期开始
                  newExpireDate = new Date(today);
                  
                  // 添加续期周期
                  switch (renewalUnit) {
                      case '天':
                          newExpireDate.setDate(newExpireDate.getDate() + renewalNumber);
                          break;
                      case '月':
                          newExpireDate.setMonth(newExpireDate.getMonth() + renewalNumber);
                          break;
                      case '年':
                          newExpireDate.setFullYear(newExpireDate.getFullYear() + renewalNumber);
                          break;
                  }
                  
                  // 如果还未过期，累加剩余天数
                  if (daysRemaining > 0) {
                      newExpireDate.setDate(newExpireDate.getDate() + daysRemaining);
                  }
                  
                  // 格式化日期为 YYYY-MM-DD
                  const formattedDate = newExpireDate.toISOString().split('T')[0];
                  document.getElementById('newExpireDate').value = formattedDate;
                  return;
              }
              
              // 对于"从到期日期开始"和"从当前日期开始"，正常添加续期周期
              switch (renewalUnit) {
                  case '天':
                      newExpireDate.setDate(newExpireDate.getDate() + renewalNumber);
                      break;
                  case '月':
                      newExpireDate.setMonth(newExpireDate.getMonth() + renewalNumber);
                      break;
                  case '年':
                      newExpireDate.setFullYear(newExpireDate.getFullYear() + renewalNumber);
                      break;
              }
              
              // 格式化日期为 YYYY-MM-DD
              const formattedDate = newExpireDate.toISOString().split('T')[0];
              document.getElementById('newExpireDate').value = formattedDate;
          }
          
          // 处理续期
          async function processRenewal(serverId, newExpireDate, renewalNumber, renewalUnit) {
              try {
                  const server = servers.find(s => s.id === serverId);
                  if (!server) {
                      throw new Error('服务器未找到');
                  }
                  
                  // 生成续期周期字符串
                  const renewalPeriod = \`\${renewalNumber}\${renewalUnit}\`;
                  
                  // 获取用户选择的续期类型
                  let renewalType = 'nowAccumulate'; // 默认值
                  if (document.getElementById('renewalFromNow').checked) {
                      renewalType = 'now';
                  } else if (document.getElementById('renewalFromNowAccumulate').checked) {
                      renewalType = 'nowAccumulate';
                  } else if (document.getElementById('renewalFromExpire').checked) {
                      renewalType = 'expire';
                  } else if (document.getElementById('renewalCustom').checked) {
                      renewalType = 'custom';
                  }
                  
                // 更新服务器信息
                const updatedServer = {
                    ...server,
                    expireDate: newExpireDate,
                    renewalPeriod: renewalPeriod, // 更新当前续期周期（自定义模式时会改变）
                    lastRenewalDate: new Date().toISOString().split('T')[0], // 记录续期日期
                    lastRenewalType: renewalType, // 记录用户选择的续期类型
                    // originalRenewalPeriod 保持不变（创建时的原始周期）
                };
                  
                  const response = await fetch(\`/api/servers/\${serverId}\`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(updatedServer)
                  });
                  
                  if (response.ok) {
                      await loadData();
                      hideRenewalModal();
                      showNotification(\`服务器续期成功！新的到期日期：\${newExpireDate}\`, 'success');
                  } else {
                      throw new Error('续期失败');
                  }
              } catch (error) {
                  showNotification('续期失败：' + error.message, 'error');
              }
          }
          
          // 编辑服务器相关变量
          let currentEditServerId = '';
          let isEditFormInitializing = false;
          
          // 显示编辑服务器模态框
          async function editServer(serverId) {
              const server = servers.find(s => s.id === serverId);
              if (!server) {
                  showNotification('服务器未找到', 'error');
                  return;
              }
              
              currentEditServerId = serverId;
              
              // 保存原始服务器数据（用于清除操作恢复）
              originalServerData = JSON.parse(JSON.stringify(server));
              
              // 重置清除标记
              isClearRenewalMarked = false;
              
              // 开始初始化表单，禁用实时检测
              isEditFormInitializing = true;
              
              // 加载分类选项
              await loadEditCategoryOptions();
              
              // 填充表单数据
              const editNameInput = document.getElementById('editServerName');
              editNameInput.value = server.name || '';
              // 清除可能的验证样式
              editNameInput.classList.remove('input-error', 'input-success');
              document.getElementById('editServerIP').value = server.ip || '';
              document.getElementById('editServerTags').value = server.tags || '';
              document.getElementById('editRegisterDate').value = server.registerDate || '';
              document.getElementById('editExpireDate').value = server.expireDate || '';
              document.getElementById('editRenewalLink').value = server.renewalLink || '';
              document.getElementById('editNotifyDays').value = server.notifyDays || 14;
              document.getElementById('editServerCategory').value = server.categoryId || '';
              
              // 处理服务商 - 先重置所有服务商字段
              document.getElementById('editServerProvider').value = '';
              document.getElementById('editCustomProvider').value = '';
              document.getElementById('editServerProvider').style.display = 'block';
              document.getElementById('editCustomProvider').style.display = 'none';
              document.getElementById('editBackToSelect').style.display = 'none';
              
              const providerOptions = ['阿里云', '腾讯云', '华为云', 'AWS', 'Google Cloud', 'Azure', 'Vultr', 'DigitalOcean', 'Linode', 'CloudCone', '搬瓦工'];
              if (server.provider && providerOptions.includes(server.provider)) {
                  document.getElementById('editServerProvider').value = server.provider;
              } else if (server.provider) {
                  document.getElementById('editServerProvider').value = '其他';
                  document.getElementById('editCustomProvider').value = server.provider;
                  toggleEditCustomProvider();
              }
              
              // 处理续期周期 - 先清空字段
              document.getElementById('editRenewalPeriodNum').value = '';
              document.getElementById('editRenewalPeriodUnit').value = '月';
              
              if (server.renewalPeriod) {
                  const { number, unit } = parseRenewalPeriod(server.renewalPeriod);
                  document.getElementById('editRenewalPeriodNum').value = number;
                  document.getElementById('editRenewalPeriodUnit').value = unit;
              }
              
              // 处理上次续期日期
              const lastRenewalGroup = document.getElementById('editLastRenewalGroup');
              const lastRenewalInput = document.getElementById('editLastRenewalDate');
              
              if (server.lastRenewalDate) {
                  lastRenewalGroup.style.display = 'block';
                  lastRenewalInput.value = server.lastRenewalDate;
              } else {
                  lastRenewalGroup.style.display = 'none';
                  lastRenewalInput.value = '';
              }
              
              // 处理价格 - 先清空所有价格字段
              document.getElementById('editPriceCurrency').value = 'CNY';
              document.getElementById('editPriceAmount').value = '';
              document.getElementById('editPriceUnit').value = '/月';
              
              // 解析价格信息
              const priceData = parseServerPrice(server.price);
              if (priceData) {
                  document.getElementById('editPriceCurrency').value = priceData.currency;
                  document.getElementById('editPriceAmount').value = priceData.amount;
                  document.getElementById('editPriceUnit').value = priceData.unit;
              }
              
              // 处理标签和颜色 - 先重置字段
              document.getElementById('editTagColor').value = 'red';
              document.getElementById('editTagPreview').style.display = 'none';
              
              // 重置所有颜色按钮的选中状态
              const colorButtons = document.querySelectorAll('#editServerModal .color-btn');
              colorButtons.forEach(btn => btn.classList.remove('selected'));
              
              if (server.tagColor) {
                  const colorName = getColorName(server.tagColor);
                  document.getElementById('editTagColor').value = colorName;
                  if (server.tags) {
                      selectEditTagColor(colorName);
                  }
              } else {
                  // 如果没有标签颜色，默认选中第一个颜色
                  document.getElementById('editTagColor').value = 'red';
                  selectEditTagColor('red');
              }
              
              // 初始化完成，重新启用实时检测
              isEditFormInitializing = false;
              
              document.getElementById('editServerModal').classList.add('show');
          }
          
          // 隐藏编辑服务器模态框
          function hideEditServerModal() {
              document.getElementById('editServerModal').classList.remove('show');
              
              // 重置清除标记和原始数据
              isClearRenewalMarked = false;
              originalServerData = null;
              
              // 手动重置所有字段（不使用form.reset()以避免影响数据填充）
              document.getElementById('editServerName').value = '';
              document.getElementById('editServerIP').value = '';
              document.getElementById('editServerTags').value = '';
              document.getElementById('editRegisterDate').value = '';
              document.getElementById('editExpireDate').value = '';
              document.getElementById('editRenewalLink').value = '';
              document.getElementById('editNotifyDays').value = '14';
              document.getElementById('editServerCategory').value = '';
              
              // 重置服务商字段
              document.getElementById('editServerProvider').value = '';
              document.getElementById('editCustomProvider').value = '';
              document.getElementById('editServerProvider').style.display = 'block';
              document.getElementById('editCustomProvider').style.display = 'none';
              document.getElementById('editBackToSelect').style.display = 'none';
              
              // 重置续期周期字段
              document.getElementById('editRenewalPeriodNum').value = '';
              document.getElementById('editRenewalPeriodUnit').value = '月';
              
              // 重置上次续期日期字段
              document.getElementById('editLastRenewalGroup').style.display = 'none';
              document.getElementById('editLastRenewalDate').value = '';
              
              // 重置价格字段
              document.getElementById('editPriceCurrency').value = 'CNY';
              document.getElementById('editPriceAmount').value = '';
              document.getElementById('editPriceUnit').value = '/月';
              
              // 重置标签和颜色
              document.getElementById('editTagColor').value = 'red';
              document.getElementById('editTagPreview').style.display = 'none';
              const colorButtons = document.querySelectorAll('#editServerModal .color-btn');
              colorButtons.forEach(btn => btn.classList.remove('selected'));
              
              currentEditServerId = '';
              isEditFormInitializing = false; // 重置初始化标志
          }
          
          // 加载编辑分类选项
          async function loadEditCategoryOptions() {
              const categorySelect = document.getElementById('editServerCategory');
              categorySelect.innerHTML = '<option value="">默认分类</option>';
              
              categories.forEach(category => {
                  const option = document.createElement('option');
                  option.value = category.id;
                  option.textContent = category.name;
                  categorySelect.appendChild(option);
              });
          }
          
          // 编辑模态框：切换自定义服务商
          function toggleEditCustomProvider() {
              const select = document.getElementById('editServerProvider');
              const customInput = document.getElementById('editCustomProvider');
              const backBtn = document.getElementById('editBackToSelect');
              
              if (select.value === '其他') {
                  select.style.display = 'none';
                  customInput.style.display = 'block';
                  customInput.focus();
                  backBtn.style.display = 'inline-block';
              }
          }
          
          // 编辑模态框：返回服务商选择
          function backToEditSelectProvider() {
              const select = document.getElementById('editServerProvider');
              const customInput = document.getElementById('editCustomProvider');
              const backBtn = document.getElementById('editBackToSelect');
              
              select.style.display = 'block';
              customInput.style.display = 'none';
              backBtn.style.display = 'none';
              select.value = '';
              customInput.value = '';
          }
          
          // 编辑模态框：处理自定义服务商失焦
          function handleEditCustomProviderBlur() {
              const customInput = document.getElementById('editCustomProvider');
              if (!customInput.value.trim()) {
                  backToEditSelectProvider();
              }
          }
          
          // 编辑模态框：选择标签颜色
          function selectEditTagColor(colorName) {
              const tagInput = document.getElementById('editServerTags');
              const tagPreview = document.getElementById('editTagPreview');
              const editTagColorInput = document.getElementById('editTagColor');
              const colorButtons = document.querySelectorAll('#editServerModal .color-btn');
              
              // 移除所有按钮的选中状态
              colorButtons.forEach(btn => btn.classList.remove('selected'));
              
              // 设置选中状态
              const selectedBtn = document.querySelector(\`#editServerModal .tag-color-\${colorName}\`);
              if (selectedBtn) {
                  selectedBtn.classList.add('selected');
              }
              
              // 更新隐藏字段
              if (editTagColorInput) {
                  editTagColorInput.value = colorName;
              }
              
              // 更新预览
              if (tagInput && tagPreview) {
                  if (tagInput.value.trim()) {
                      tagPreview.innerHTML = '<i class="iconfont icon-tags"></i>' + tagInput.value.trim();
                      // 获取实际颜色值并设置样式
                      const colorValue = getColorValue(colorName);
                      tagPreview.style.backgroundColor = colorValue + '20'; // 20% 透明度
                      tagPreview.style.color = colorValue;
                      tagPreview.style.borderColor = colorValue + '40'; // 40% 透明度
                      tagPreview.style.opacity = '1';
                      tagPreview.style.display = 'block';
                  } else {
                      tagPreview.style.display = 'none';
                  }
              }
          }
          
          // 编辑模态框：计算到期日期
          function calculateEditExpireDate() {
              const registerDate = document.getElementById('editRegisterDate').value;
              const renewalNum = parseInt(document.getElementById('editRenewalPeriodNum').value);
              const renewalUnit = document.getElementById('editRenewalPeriodUnit').value;
              
              if (!registerDate || !renewalNum || renewalNum <= 0) {
                  return;
              }
              
              const register = new Date(registerDate);
              let expireDate = new Date(register);
              
              switch (renewalUnit) {
                  case '天':
                      expireDate.setDate(expireDate.getDate() + renewalNum);
                      break;
                  case '月':
                      expireDate.setMonth(expireDate.getMonth() + renewalNum);
                      break;
                  case '年':
                      expireDate.setFullYear(expireDate.getFullYear() + renewalNum);
                      break;
              }
              
              const formattedDate = expireDate.toISOString().split('T')[0];
              document.getElementById('editExpireDate').value = formattedDate;
          }
          
          // 标记是否已清除续期记录（延迟执行，只有保存时才真正清除）
          let isClearRenewalMarked = false;
          let originalServerData = null; // 保存原始服务器数据
          
          // 清除上次续期日期（仅在界面上标记，不立即保存）
          async function clearLastRenewalDate() {
              if (!currentEditServerId) {
                  showNotification('未找到服务器信息', 'error');
                  return;
              }
              
              const result = await showConfirmDialog(
                  '确认清除续期记录',
                  '确定要清除续期记录吗？这将清除上次续期日期和续期偏好设置，并根据注册日期+续期周期重新计算到期日期。需要点击"保存修改"才会生效。',
                  '<i class="iconfont icon-triangle-exclamation"></i>'
              );
              
              if (result) {
                  // 标记为已清除，但不立即保存
                  isClearRenewalMarked = true;
                  
                  const server = servers.find(s => s.id === currentEditServerId);
                  if (!server) return;
                  
                  // 隐藏上次续期日期显示
                  document.getElementById('editLastRenewalGroup').style.display = 'none';
                  document.getElementById('editLastRenewalDate').value = '';
                  
                  // 恢复到最初的设置：使用原始注册日期和原始续期周期
                  if (originalServerData && originalServerData.registerDate) {
                      // 使用原始续期周期（优先使用originalRenewalPeriod，否则使用renewalPeriod）
                      const originalPeriod = originalServerData.originalRenewalPeriod || originalServerData.renewalPeriod;
                      
                      if (originalPeriod) {
                          const registerDate = new Date(originalServerData.registerDate);
                          const { number, unit } = parseRenewalPeriod(originalPeriod);
                          
                          let newExpireDate = new Date(registerDate);
                          switch (unit) {
                              case '天':
                                  newExpireDate.setDate(newExpireDate.getDate() + number);
                                  break;
                              case '月':
                                  newExpireDate.setMonth(newExpireDate.getMonth() + number);
                                  break;
                              case '年':
                                  newExpireDate.setFullYear(newExpireDate.getFullYear() + number);
                                  break;
                          }
                          
                          // 更新界面显示
                          document.getElementById('editRegisterDate').value = originalServerData.registerDate;
                          document.getElementById('editExpireDate').value = newExpireDate.toISOString().split('T')[0];
                          
                          // 恢复原始续期周期显示
                          document.getElementById('editRenewalPeriodNum').value = number;
                          document.getElementById('editRenewalPeriodUnit').value = unit;
                      }
                  }
                  
                  showNotification('已标记清除，点击"保存修改"后生效', 'info');
              }
          }
          
          // 复选框选中状态管理
          let selectedServers = new Set();
          
          // 更新选中状态显示
          function updateSelectionUI() {
              // 统计每个分类下的选中数量
              const selectionByCategory = {};
              
              servers.forEach(server => {
                  const categoryId = server.categoryId || '';
                  if (!selectionByCategory[categoryId]) {
                      selectionByCategory[categoryId] = 0;
                  }
                  if (selectedServers.has(server.id)) {
                      selectionByCategory[categoryId]++;
                  }
              });
              
              // 更新每个分类的批量删除按钮显示
              Object.keys(selectionByCategory).forEach(categoryId => {
                  const count = selectionByCategory[categoryId];
                  const btnId = \`batchDeleteBtn-\${categoryId}\`;
                  const countId = \`selectedCount-\${categoryId}\`;
                  
                  const btn = document.getElementById(btnId);
                  const countSpan = document.getElementById(countId);
                  
                  if (btn && countSpan) {
                      if (count > 0) {
                          btn.style.display = 'inline-block';
                          countSpan.textContent = count;
                      } else {
                          btn.style.display = 'none';
                      }
                  }
              });
              
              // 更新分类全选复选框状态
              categories.forEach(category => {
                  updateCategorySelectAll(category.id);
              });
              updateCategorySelectAll(''); // 默认分类
          }
          
          // 更新分类全选复选框状态
          function updateCategorySelectAll(categoryId) {
              const categoryServers = servers.filter(server => {
                  const serverCategoryId = server.categoryId || '';
                  return serverCategoryId === categoryId;
              });
              
              if (categoryServers.length === 0) return;
              
              const selectedCount = categoryServers.filter(server => selectedServers.has(server.id)).length;
              const selectAllCheckbox = document.querySelector(\`input[data-category-id="\${categoryId}"].category-select-all\`);
              
              if (selectAllCheckbox) {
                  if (selectedCount === 0) {
                      selectAllCheckbox.checked = false;
                      selectAllCheckbox.indeterminate = false;
                  } else if (selectedCount === categoryServers.length) {
                      selectAllCheckbox.checked = true;
                      selectAllCheckbox.indeterminate = false;
                  } else {
                      selectAllCheckbox.checked = false;
                      selectAllCheckbox.indeterminate = true;
                  }
              }
          }
          
          // 处理复选框点击事件
          function handleCheckboxChange(event) {
              const checkbox = event.target;
              if (checkbox.classList.contains('monitor-card-checkbox')) {
                  const serverId = checkbox.getAttribute('data-server-id');
                  const serverCard = checkbox.closest('.server-card');
                  
                  if (checkbox.checked) {
                      selectedServers.add(serverId);
                      serverCard.classList.add('selected');
                  } else {
                      selectedServers.delete(serverId);
                      serverCard.classList.remove('selected');
                  }
                  
                  updateSelectionUI();
              }
          }
          
          // 批量删除服务器
          async function batchDeleteServers(categoryId) {
              const categoryServers = servers.filter(server => {
                  const serverCategoryId = server.categoryId || '';
                  return serverCategoryId === categoryId && selectedServers.has(server.id);
              });
              
              if (categoryServers.length === 0) {
                  showNotification('请先选择要删除的服务器', 'warning');
                  return;
              }
              
              const serverNames = categoryServers.map(s => s.name).join('、');
              const categoryName = categoryId ? categories.find(c => c.id === categoryId)?.name || '未知分类' : '默认分类';
              
              const confirmed = await showConfirmDialog(
                  '批量删除服务器',
                  \`您确定要删除 "\${categoryName}" 分类下的以下 \${categoryServers.length} 台服务器吗？\\n\\n\${serverNames}\\n\\n此操作不可恢复。\`,
                  '<i class="iconfont icon-fuwuqi"></i>',
                  '删除',
                  '取消'
              );
              
              if (!confirmed) {
                  return;
              }
              
              try {
                  // 逐个删除服务器
                  let successCount = 0;
                  let errorCount = 0;
                  
                  for (const server of categoryServers) {
                      try {
                          const response = await fetch(\`/api/servers/\${server.id}\`, {
                              method: 'DELETE'
                          });
                          
                          if (response.ok) {
                              successCount++;
                              selectedServers.delete(server.id);
                          } else {
                              errorCount++;
                          }
                      } catch (error) {
                          errorCount++;
                      }
                  }
                  
                  if (successCount > 0) {
                      await loadData();
                      updateSelectionUI();
                      
                      if (errorCount === 0) {
                          showNotification(\`成功删除 \${successCount} 台服务器！\`, 'success');
                      } else {
                          showNotification(\`成功删除 \${successCount} 台服务器，\${errorCount} 台删除失败\`, 'warning');
                      }
                  } else {
                      showNotification('删除失败，请重试', 'error');
                  }
              } catch (error) {
                  showNotification('批量删除出错：' + error.message, 'error');
              }
          }
          
          // 全选/取消全选功能
          function toggleSelectAll(categoryId) {
              const categoryServers = servers.filter(server => {
                  const serverCategoryId = server.categoryId || '';
                  return serverCategoryId === categoryId;
              });
              
              const allSelected = categoryServers.every(server => selectedServers.has(server.id));
              
              categoryServers.forEach(server => {
                  const checkbox = document.querySelector(\`input[data-server-id="\${server.id}"]\`);
                  const serverCard = checkbox ? checkbox.closest('.server-card') : null;
                  
                  if (allSelected) {
                      selectedServers.delete(server.id);
                      if (checkbox) checkbox.checked = false;
                      if (serverCard) serverCard.classList.remove('selected');
                  } else {
                      selectedServers.add(server.id);
                      if (checkbox) checkbox.checked = true;
                      if (serverCard) serverCard.classList.add('selected');
                  }
              });
              
              updateSelectionUI();
          }
          
          // 自定义确认对话框相关函数
          let confirmCallback = null;
          
          function showConfirmDialog(title, message, icon = '⚠️', okText = '确定', cancelText = '取消') {
              return new Promise((resolve) => {
                  document.getElementById('confirmTitle').textContent = title;
                  document.getElementById('confirmMessage').textContent = message;
                  document.getElementById('confirmIcon').innerHTML = icon;
                  document.getElementById('confirmOkBtn').textContent = okText;
                  
                  confirmCallback = resolve;
                  document.getElementById('confirmOverlay').classList.add('show');
              });
          }
          
          function hideConfirmDialog() {
              document.getElementById('confirmOverlay').classList.remove('show');
              if (confirmCallback) {
                  confirmCallback(false);
                  confirmCallback = null;
              }
          }
          
          function confirmOkAction() {
              document.getElementById('confirmOverlay').classList.remove('show');
              if (confirmCallback) {
                  confirmCallback(true);
                  confirmCallback = null;
              }
          }
          
          // 点击遮罩层关闭对话框
          document.addEventListener('DOMContentLoaded', function() {
              document.getElementById('confirmOverlay').addEventListener('click', function(e) {
                  if (e.target === this) {
                      hideConfirmDialog();
                  }
              });
              
              // ESC键关闭对话框
              document.addEventListener('keydown', function(e) {
                  if (e.key === 'Escape' && document.getElementById('confirmOverlay').classList.contains('show')) {
                      hideConfirmDialog();
                  }
              });
              
              // 添加复选框事件委托
              document.body.addEventListener('change', handleCheckboxChange);
          });
          
          // 通知系统
          function showNotification(message, type = 'info', duration = 2000) {
              const icons = {
                  success: '✅',
                  error: '❌',
                  warning: '⚠️',
                  info: 'ℹ️'
              };
              
              const notification = document.createElement('div');
              notification.className = \`notification \${type}\`;
              notification.innerHTML = \`
                  <div class="notification-content">
                      <div class="notification-icon">\${icons[type] || icons.info}</div>
                      <div class="notification-text">\${message}</div>
                      <button class="notification-close" onclick="closeNotification(this)">&times;</button>
                  </div>
              \`;
              
              // 添加到通知容器的顶部（最新消息在前）
              const container = document.getElementById('notificationContainer');
              container.insertBefore(notification, container.firstChild);
              
              // 触发显示动画
              setTimeout(() => {
                  notification.classList.add('show');
              }, 100);
              
              // 自动隐藏
              setTimeout(() => {
                  closeNotification(notification.querySelector('.notification-close'));
              }, duration);
          }
          
          function closeNotification(closeBtn) {
              const notification = closeBtn.closest('.notification');
              if (notification) {
                  notification.classList.remove('show');
                  // 添加渐出动画
                  notification.style.opacity = '0';
                  notification.style.transform = 'translateX(100%) scale(0.95)';
                  
                  setTimeout(() => {
                      if (notification.parentNode) {
                          notification.remove();
                      }
                  }, 300);
              }
          }

      </script>
  </body>
  </html>`;
  }

// 登录页面HTML
function getLoginHTML(settings = {}) {
  const siteTitle = (settings.siteTitle && settings.siteTitle.trim() !== '') ? settings.siteTitle : 'VPS监控系统';
  // 获取自定义Logo URL，如果没有则使用默认值
  const logoUrl = (settings.customLogoUrl && settings.customLogoUrl.trim() !== '') ? settings.customLogoUrl : LOGO_IMAGE_URL;
  // 根据Logo格式确定CSS类
  const logoClass = logoUrl.toLowerCase().includes('.svg') || logoUrl.toLowerCase().includes('format=svg') ? 'logo-image svg-logo' : 'logo-image raster-logo';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

    <title>登录 - ${siteTitle}</title>
    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="https://cdn.jsdelivr.net/gh/kamanfaiz/CF-Server-AutoCheck@main/images/logo.svg">
    <link rel="stylesheet" href="${ICONFONT_CSS_URL}">
    <style>
        ${getColorVariables()}

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-light);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.3s ease;
            position: relative;
            /* 移动端优化 */
            -webkit-overflow-scrolling: touch;
        }
        
        /* 移动端背景图优化 */
        @media (max-width: 768px) {
            body {
                min-height: 100vh;
            }
            
            #login-fixed-bg-container {
                position: fixed !important;
                width: 100vw !important;
                height: 100vh !important;
                /* 移动端特殊处理：确保背景图固定为视口大小 */
                min-height: 100vh;
                background-attachment: scroll !important;
            }
        }
        


        .login-container {
            background: var(--bg-primary);
            border-radius: 16px;
            padding: 48px 40px;
            width: 100%;
            max-width: 400px;
            text-align: center;
            border: 1px solid var(--border-color);
            transition: all 0.3s ease;
            position: relative;
        }

        .login-header {
            margin-bottom: 32px;
        }

        .login-header h1 {
            color: var(--text-primary);
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .login-header h1 .logo-image {
            width: 32px;
            height: 32px;
            margin-right: 8px;
            display: inline-block;
            transition: filter 0.3s ease, opacity 0.3s ease;
        }
        
        /* SVG Logo - 使用滤镜适配主题 */
        .login-header h1 .logo-image.svg-logo {
            filter: brightness(0) saturate(100%) invert(var(--logo-invert)) sepia(100%) saturate(var(--logo-saturate)) hue-rotate(var(--logo-hue)) brightness(var(--logo-brightness)) contrast(var(--logo-contrast));
        }
        
        /* PNG/JPG/WebP Logo - 保持原始颜色 */
        .login-header h1 .logo-image.raster-logo {
            filter: none;
        }

        .login-header p {
            color: var(--text-secondary);
            font-size: 14px;
        }

        ${getThemeToggleCSS()}

        .login-form {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        .form-group {
            position: relative;
        }

        .form-group label {
            display: block;
            text-align: left;
            color: var(--text-primary);
            font-weight: 500;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .form-group .iconfont {
            margin-right: 6px;
            color: var(--text-primary);
        }

        .form-group input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid var(--border-color);
            border-radius: 8px;
            font-size: 16px;
            transition: all 0.3s ease;
            background: var(--bg-secondary);
            color: var(--text-primary);
        }

        .form-group input:focus {
            outline: none;
            border-color: var(--primary-color);
            background: var(--bg-primary);
            box-shadow: 0 0 0 3px var(--primary-shadow);
        }

        /* 登录页面密码输入框包装器样式 */
        .password-input-wrapper {
            position: relative;
            display: flex;
            align-items: center;
        }

        .password-input-wrapper input {
            flex: 1;
            padding-right: 45px; /* 为图标留出空间 */
        }

        .password-toggle {
            position: absolute;
            right: 15px;
            cursor: pointer;
            color: var(--text-secondary);
            font-size: 18px;
            transition: color 0.2s;
            user-select: none;
            z-index: 1;
        }

        .password-toggle:hover {
            color: var(--text-primary);
        }

        .login-btn {
            padding: 14px;
            background: var(--primary-color);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 8px;
        }

        .login-btn:hover {
            background: var(--primary-dark);
            transform: translateY(-2px);
            box-shadow: 0 8px 20px var(--primary-shadow);
        }

        .login-btn:active {
            transform: translateY(0);
        }

        .login-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .error-message {
            background: var(--danger-color);
            color: white;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            display: none;
            text-align: center;
            margin-bottom: 16px;
            transition: opacity 0.3s ease, transform 0.3s ease;
            opacity: 1;
            transform: translateY(0);
        }

        .error-message.fade-out {
            opacity: 0;
            transform: translateY(-10px);
        }

        .footer {
            margin-top: 32px;
            color: var(--text-secondary);
            font-size: 12px;
        }

        /* GitHub角标样式 */
        .github-corner {
            position: fixed;
            top: 0;
            right: 0;
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 0 100px 100px 0;
            border-color: transparent var(--primary-color) transparent transparent;
            color: white;
            text-decoration: none;
            z-index: 1000;
            transition: all 0.3s ease;
            overflow: visible;
        }

        .github-corner:hover {
            border-color: transparent var(--primary-dark) transparent transparent;
        }

        .github-corner i {
            position: absolute;
            top: 18px;
            right: -82.5px;
            font-size: 40px;
            transform: rotate(45deg);
            line-height: 1;
            display: inline-block;
            width: 40px;
            height: 40px;
            text-align: center;
        }

        /* 移动端适配 */
        @media (max-width: 768px) {
            body {
                padding: 10px;
                overflow-x: hidden;
            }

            .container {
                width: 100%;
                max-width: 100%;
                margin: 20px auto;
                padding: 20px 15px;
                border-radius: 12px;
            }

            .login-form {
                padding: 0;
            }

            .login-title {
                font-size: 20px;
                margin-bottom: 20px;
            }

            .form-group {
                margin-bottom: 15px;
            }

            .form-control {
                padding: 12px;
                font-size: 16px; /* 防止iOS缩放 */
                border-radius: 8px;
            }

            .btn {
                padding: 12px;
                font-size: 16px;
                border-radius: 8px;
                touch-action: manipulation;
            }

            .github-corner {
                top: 15px;
                right: 15px;
                width: 35px;
                height: 35px;
            }

            .github-corner .iconfont {
                width: 35px;
                height: 35px;
                font-size: 18px;
                line-height: 35px;
            }

            .theme-toggle-container {
                top: 15px;
                left: 15px;
            }

            .theme-toggle {
                transform: scale(0.8);
            }

            /* 确保文本不会溢出 */
            * {
                word-wrap: break-word;
                word-break: break-word;
                overflow-wrap: break-word;
            }

            /* 优化触摸操作 */
            .btn, .form-control {
                touch-action: manipulation;
            }

            /* 移动端隐藏GitHub角标 */
            .github-corner {
                display: none;
            }
        }

        /* 小屏幕设备进一步优化 */
        @media (max-width: 480px) {
            .container {
                margin: 10px auto;
                padding: 15px 10px;
            }

            .login-title {
                font-size: 18px;
            }

            .form-control {
                padding: 10px;
            }

            .btn {
                padding: 10px;
            }
        }
    </style>
</head>
<body>
    <!-- GitHub角标 -->
    <a href="https://github.com/kamanfaiz/CF-Server-AutoCheck" target="_blank" class="github-corner" title="GitHub Repository">
        <i class="iconfont icon-github1"></i>
    </a>
    
    <!-- 背景图和主题切换按钮 -->
    <div class="theme-toggle-container">
        <label class="theme-toggle">
            <input type="checkbox" id="theme-switch">
            <span class="slider">
                <i class="iconfont icon-taiyang sun-icon"></i>
                <i class="iconfont icon-zhutiqiehuan moon-icon"></i>
            </span>
        </label>
        <button class="bg-toggle-btn" onclick="toggleBackgroundImage()" id="bgToggleBtn" title="开关背景图">
            <i class="iconfont icon-images"></i>
        </button>
    </div>

    <div class="login-container">
        <div class="login-header">
            <h1><img src="${logoUrl}" alt="Logo" class="${logoClass}" id="loginLogoImage"> ${siteTitle}</h1>
            <p>请输入密码以访问控制面板</p>
        </div>

        <form class="login-form" id="loginForm">
            <div class="error-message" id="errorMessage"></div>
            
            <div class="form-group">
                <label for="password">
                    <i class="iconfont icon-key"></i> 登录密码
                </label>
                <div class="password-input-wrapper">
                    <input 
                        type="password" 
                        id="password" 
                        name="password" 
                        placeholder="请输入登录密码"
                        autocomplete="current-password"
                        required
                    >
                    <i class="iconfont icon-bukejian password-toggle" onclick="togglePasswordVisibility('password')" title="显示/隐藏密码"></i>
                </div>
            </div>

            <button type="submit" class="login-btn" id="loginBtn">
                <i class="iconfont icon-login"></i> 登录
            </button>
        </form>

        <div class="footer">
            <p>Copyright &copy; 2025 Faiz</p>
        </div>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const password = document.getElementById('password').value;
            const loginBtn = document.getElementById('loginBtn');
            const errorMessage = document.getElementById('errorMessage');
            
            if (!password.trim()) {
                showError('请输入密码');
                return;
            }
            
            // 显示加载状态
            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="iconfont icon-loading"></i> 登录中...';
            errorMessage.style.display = 'none';
            
            try {
                const response = await fetch('/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ password: password })
                });
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    // 登录成功，设置标记表示将要跳转到主页面
                    sessionStorage.setItem('fromLoginPage', 'true');
                    // 跳转到dashboard
                    window.location.href = '/dashboard';
                } else {
                    showError(result.error || '登录失败');
                }
            } catch (error) {
                console.error('Login error:', error);
                showError('网络连接错误，请重试');
            } finally {
                // 恢复按钮状态
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<i class="iconfont icon-login"></i> 登录';
            }
        });
        
        function showError(message) {
            const errorMessage = document.getElementById('errorMessage');
            errorMessage.textContent = message;
            errorMessage.style.display = 'block';
            errorMessage.classList.remove('fade-out');
            
            // 清除之前的定时器（如果存在）
            if (window.errorTimeout) {
                clearTimeout(window.errorTimeout);
            }
            if (window.hideTimeout) {
                clearTimeout(window.hideTimeout);
            }
            
            // 设置1.5秒后开始淡出动画
            window.errorTimeout = setTimeout(() => {
                errorMessage.classList.add('fade-out');
                
                // 动画完成后隐藏元素
                window.hideTimeout = setTimeout(() => {
                    errorMessage.style.display = 'none';
                    errorMessage.classList.remove('fade-out');
                }, 300); // 与CSS transition时间一致
            }, 1500);
        }
        
        // 切换密码显示/隐藏状态
        function togglePasswordVisibility(inputId) {
            const input = document.getElementById(inputId);
            const toggleIcon = input.parentElement.querySelector('.password-toggle');
            
            if (input.type === 'password') {
                // 显示密码
                input.type = 'text';
                toggleIcon.className = 'iconfont icon-kejian password-toggle';
            } else {
                // 隐藏密码
                input.type = 'password';
                toggleIcon.className = 'iconfont icon-bukejian password-toggle';
            }
        }
        
        // 主题切换功能
        function toggleTheme() {
            const html = document.documentElement;
            const themeSwitch = document.getElementById('theme-switch');
            
            if (themeSwitch.checked) {
                html.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
            } else {
                html.removeAttribute('data-theme');
                localStorage.setItem('theme', 'light');
            }
            
            // 更新背景图样式，确保覆盖层在主题切换后正确应用
            // 延迟一下以确保DOM属性已经更新
            setTimeout(() => {
                const backgroundEnabled = getBackgroundEnabled();
                updateLoginBackgroundStyles(backgroundEnabled);
            }, 10);
        }
        
        function initTheme() {
            const savedTheme = localStorage.getItem('theme');
            const themeSwitch = document.getElementById('theme-switch');
            const html = document.documentElement;
            
            if (savedTheme === 'dark') {
                html.setAttribute('data-theme', 'dark');
                if (themeSwitch) {
                    themeSwitch.checked = true;
                }
            } else {
                html.removeAttribute('data-theme');
                if (themeSwitch) {
                    themeSwitch.checked = false;
                }
            }
        }
        

        
        // 获取自定义背景图URL（登录页面版本）
        async function getLoginCustomBackgroundUrl(isMobile = false) {
            try {
                const response = await fetch('/api/settings');
                const settings = await response.json();
                if (isMobile) {
                    return settings.customMobileBackgroundUrl || '';
                } else {
                    return settings.customDesktopBackgroundUrl || '';
                }
            } catch (error) {
                console.error('Failed to get custom background URL:', error);
                return '';
            }
        }
        
        async function updateLoginBackgroundImage() {
            // 检查背景图是否被启用
            const isEnabled = getBackgroundEnabled();
            if (!isEnabled) {
                // 背景图被禁用，清除背景图和相关样式
                document.body.style.backgroundImage = '';
                // 重置body背景色，让CSS主题变量生效
                document.body.style.backgroundColor = '';
                document.body.style.position = '';
                document.body.style.minHeight = '';
                
                // 移除固定背景容器
                const bgContainer = document.getElementById('login-fixed-bg-container');
                if (bgContainer) {
                    bgContainer.remove();
                }
                // 移除覆盖层样式
                const overlayStyle = document.getElementById('login-bg-overlay-style');
                if (overlayStyle) {
                    overlayStyle.remove();
                }
                updateLoginBackgroundStyles(false);
                return;
            }
            
            // 根据屏幕宽度选择背景图
            const isMobile = window.innerWidth <= 768;
            
            // 获取对应平台的自定义背景图URL
            const customBgUrl = await getLoginCustomBackgroundUrl(isMobile);
            const loginBackgroundImageUrl = \`${DESKTOP_BACKGROUND}\`;
            const loginMobileBackgroundImageUrl = \`${MOBILE_BACKGROUND}\`;
            const defaultBgUrl = isMobile ? loginMobileBackgroundImageUrl : loginBackgroundImageUrl;
            const finalBgUrl = customBgUrl || defaultBgUrl;
            
            // 移除可能存在的旧样式（伪元素样式已弃用）
            const existingMobileStyle = document.getElementById('login-mobile-bg-style');
            if (existingMobileStyle) {
                existingMobileStyle.remove();
            }
            const existingDesktopStyle = document.getElementById('login-desktop-bg-style');
            if (existingDesktopStyle) {
                existingDesktopStyle.remove();
            }
            
            // 设置背景图（优先使用自定义背景图）
            if (finalBgUrl) {
                // 移除body上的背景设置，改用固定背景容器
                document.body.style.backgroundImage = '';
                document.body.style.backgroundColor = 'transparent';
                document.body.style.position = 'relative';
                document.body.style.minHeight = '100vh';
                
                // 创建或更新固定背景容器
                let bgContainer = document.getElementById('login-fixed-bg-container');
                if (!bgContainer) {
                    bgContainer = document.createElement('div');
                    bgContainer.id = 'login-fixed-bg-container';
                    document.body.appendChild(bgContainer);
                }
                
                // 设置固定背景容器样式 - 移动端优化
                const isMobile = window.innerWidth <= 768;
                
                if (isMobile) {
                    // 移动端：使用固定视口尺寸，不受页面内容影响
                    bgContainer.style.cssText = \`
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100vw;
                        height: 100vh;
                        background-image: url('\${finalBgUrl}');
                        background-size: cover;
                        background-position: center;
                        background-repeat: no-repeat;
                        z-index: -1;
                        pointer-events: none;
                        /* 移动端特殊处理：避免地址栏影响 */
                        min-height: 100vh;
                    \`;
                } else {
                    // 桌面端：标准fixed布局
                    bgContainer.style.cssText = \`
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100vw;
                        height: 100vh;
                        background-image: url('\${finalBgUrl}');
                        background-size: cover;
                        background-position: center;
                        background-repeat: no-repeat;
                        z-index: -1;
                        pointer-events: none;
                    \`;
                }
                
                // 创建深色模式覆盖层样式
                let overlayStyle = document.getElementById('login-bg-overlay-style');
                if (!overlayStyle) {
                    overlayStyle = document.createElement('style');
                    overlayStyle.id = 'login-bg-overlay-style';
                    document.head.appendChild(overlayStyle);
                }
                
                overlayStyle.textContent = \`
                    #login-fixed-bg-container::after {
                        content: '';
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: var(--background-overlay);
                        pointer-events: none;
                        z-index: 1;
                    }
                \`;
                
                // 监听窗口大小变化，更新背景容器尺寸
                const updateLoginBgSize = () => {
                    if (bgContainer) {
                        bgContainer.style.width = '100vw';
                        bgContainer.style.height = '100vh';
                    }
                };
                
                // 移除可能存在的旧监听器
                window.removeEventListener('resize', window.loginBgResizeHandler);
                // 添加新的监听器
                window.loginBgResizeHandler = updateLoginBgSize;
                window.addEventListener('resize', window.loginBgResizeHandler);
                
                // 更新背景图相关样式
                updateLoginBackgroundStyles(true);
            }
        }
        
        async function initLoginBackground() {
            // 首先更新按钮状态
            updateLoginBackgroundToggleButton();
            
            // 设置固定背景图
            await updateLoginBackgroundImage();
        }
        
        // 背景图开关相关函数（登录页面）
        function getBackgroundEnabled() {
            const stored = localStorage.getItem('background_enabled');
            return stored !== null ? stored === 'true' : true; // 默认开启
        }
        
        function setBackgroundEnabled(enabled) {
            localStorage.setItem('background_enabled', enabled.toString());
        }
        
        function updateLoginBackgroundStyles(enabled) {
            const root = document.documentElement;
            const currentTheme = document.documentElement.getAttribute('data-theme');
            
            if (enabled) {
                // 启用背景图样式 - 使用透明背景
                root.style.setProperty('--bg-primary', 'var(--bg-primary-transparent)');
                root.style.setProperty('--bg-secondary', 'var(--bg-secondary-transparent)');
                root.style.setProperty('--navbar-bg', 'var(--navbar-bg-transparent)');
                root.style.setProperty('--footer-bg', 'var(--footer-bg-transparent)');
                
                // 深色模式下启用覆盖层
                if (currentTheme === 'dark') {
                    root.style.setProperty('--background-overlay', 'var(--background-overlay-enabled)');
                }
            } else {
                // 禁用背景图样式 - 移除透明背景，恢复正常背景
                root.style.removeProperty('--bg-primary');
                root.style.removeProperty('--bg-secondary');
                root.style.removeProperty('--navbar-bg');
                root.style.removeProperty('--footer-bg');
                
                // 禁用覆盖层
                root.style.setProperty('--background-overlay', 'transparent');
            }
        }
        
        function toggleBackgroundImage() {
            const currentState = getBackgroundEnabled();
            const newState = !currentState;
            setBackgroundEnabled(newState);
            
            // 更新按钮状态
            updateLoginBackgroundToggleButton();
            
            // 先更新背景样式，确保主题状态正确
            updateLoginBackgroundStyles(newState);
            
            if (newState) {
                // 启用背景图，立即显示一张随机背景图
                updateLoginBackgroundImage(true);
            } else {
                // 禁用背景图，清除当前背景图和样式
                document.body.style.backgroundImage = '';
                // 重置body背景色，让CSS主题变量生效
                document.body.style.backgroundColor = '';
                document.body.style.position = '';
                document.body.style.minHeight = '';
                
                // 移除固定背景容器
                const bgContainer = document.getElementById('login-fixed-bg-container');
                if (bgContainer) {
                    bgContainer.remove();
                }
                // 移除覆盖层样式
                const overlayStyle = document.getElementById('login-bg-overlay-style');
                if (overlayStyle) {
                    overlayStyle.remove();
                }
            }
        }
        
        function updateLoginBackgroundToggleButton() {
            const btn = document.getElementById('bgToggleBtn');
            if (btn) {
                const isEnabled = getBackgroundEnabled();
                if (isEnabled) {
                    btn.classList.add('active');
                    btn.title = '关闭背景图';
                } else {
                    btn.classList.remove('active');
                    btn.title = '开启背景图';
                }
            }
        }
        
        // 初始化登录页面Logo
        async function initLoginLogo() {
            try {
                const response = await fetch('/api/settings');
                const settings = await response.json();
                const customLogoUrl = settings.customLogoUrl || '';
                const finalLogoUrl = customLogoUrl || '${LOGO_IMAGE_URL}';
                
                const logoImg = document.getElementById('loginLogoImage');
                if (logoImg) {
                    logoImg.src = finalLogoUrl;
                }
            } catch (error) {
                // 如果获取设置失败，使用默认logo
                const logoImg = document.getElementById('loginLogoImage');
                if (logoImg) {
                    logoImg.src = '${LOGO_IMAGE_URL}';
                }
            }
        }

        // 页面加载完成后初始化主题
        document.addEventListener('DOMContentLoaded', async function() {
            initTheme();
            await initLoginBackground(); // 初始化登录页面背景图
            
            // 监听窗口大小变化（添加防抖功能）
            let loginResizeTimeout;
            window.addEventListener('resize', function() {
                // 防抖：更新背景图以适应新的窗口尺寸
                clearTimeout(loginResizeTimeout);
                loginResizeTimeout = setTimeout(() => {
                    updateLoginBackgroundImage(); // 更新背景图尺寸和切换桌面端/移动端背景图
                }, 150);
            });
            
            // 绑定主题切换事件
            const themeSwitch = document.getElementById('theme-switch');
            if (themeSwitch) {
                themeSwitch.addEventListener('change', toggleTheme);
            }
        });
        
        // 初始化主题（立即执行）
        initTheme();
        
        // 绑定主题切换事件
        const themeSwitch = document.getElementById('theme-switch');
        if (themeSwitch) {
            themeSwitch.addEventListener('change', toggleTheme);
        }
        
        // 自动聚焦密码框
        document.getElementById('password').focus();
        
        // 回车键提交
        document.getElementById('password').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('loginForm').dispatchEvent(new Event('submit'));
            }
        });
    </script>
</body>
</html>`;
}

// 检查是否需要认证
async function isAuthRequired(env) {
    try {
        const config = await getFullConfig(env);
        
        // 如果有密码配置（任何来源），则需要认证
        const hasPassword = config.auth.password && config.auth.password.trim() !== '';
        
        // 如果存在外置配置或者网页端启用了认证，且有密码，则需要认证
        return config.auth.enabled === true && hasPassword;
    } catch (error) {
        console.error('Error checking auth requirement:', error);
        return false;
    }
}

// ==========================================
// 7. 认证相关函数
// ==========================================

// 检查认证状态（返回详细的认证信息）
async function checkAuth(request, env) {
    try {
        const cookieHeader = request.headers.get('Cookie');
        if (!cookieHeader) return { isAuthenticated: false };
        
        const cookies = parseCookies(cookieHeader);
        const token = cookies['auth_token'];
        if (!token) return { isAuthenticated: false };
        
        // 验证token
        const config = await getFullConfig(env);
        if (!config.auth.enabled) return { isAuthenticated: true };
        
        // 解析token格式：hash:timestamp
        const [hash, timestampStr] = token.split(':');
        if (!hash || !timestampStr) return { isAuthenticated: false };
        
        const timestamp = parseInt(timestampStr);
        const currentTime = Math.floor(Date.now() / 1000);
        
        // 检查token是否过期（30分钟有效期）
        const TOKEN_VALIDITY = 30 * 60; // 30分钟
        if (currentTime - timestamp > TOKEN_VALIDITY) {
            return { isAuthenticated: false };
        }
        
        // 验证token签名
        const expectedToken = await generateToken(config.auth.password, timestamp);
        const isValid = token === expectedToken;
        
        return { isAuthenticated: isValid };
    } catch (error) {
        console.error('Auth check error:', error);
        return { isAuthenticated: false };
    }
}

// 处理登录
async function handleLogin(request, env) {
    try {
        const { password } = await request.json();
        
        if (!password) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: '请输入密码' 
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        const config = await getFullConfig(env);
        
        if (!config.auth.enabled || !config.auth.password) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: '认证未启用' 
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        if (password !== config.auth.password) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: '密码错误' 
            }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        // 生成认证token
        const token = await generateToken(password);
        
        // 检测是否为HTTPS环境
        const isHttps = request.url.startsWith('https://');
        const secureFlag = isHttps ? 'Secure; ' : '';
        
        return new Response(JSON.stringify({ 
            success: true 
        }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Set-Cookie': `auth_token=${token}; Path=/; HttpOnly; ${secureFlag}SameSite=Strict; Max-Age=1800`
            }
        });
        
    } catch (error) {
        return new Response(JSON.stringify({ 
            success: false, 
            error: '服务器错误' 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// 处理登出
async function handleLogout(request) {
    // 检测是否为HTTPS环境
    const isHttps = request ? request.url.startsWith('https://') : false;
    const secureFlag = isHttps ? 'Secure; ' : '';
    
    return new Response('', {
        status: 302,
        headers: {
            'Location': '/',
            'Set-Cookie': `auth_token=; Path=/; HttpOnly; ${secureFlag}SameSite=Strict; Max-Age=0`
        }
    });
}



// ==========================================
// 8. 配置管理函数
// ==========================================

// 获取设置数据的辅助函数
async function getSettingsData(env) {
    const data = await env.SERVER_MONITOR?.get('settings');
    return data ? JSON.parse(data) : {};
}

// 获取配置值（按优先级：环境变量 > 代码配置 > 网页设置）
async function getConfigValue(env, category, key, webSettings = null) {
    // 1. 优先级最高：Cloudflare环境变量
    const envVarMap = {
        'telegram.botToken': 'TG_TOKEN',
        'telegram.chatId': 'TG_ID', 
        'auth.password': 'PASS'
    };
    
    const envKey = envVarMap[`${category}.${key}`];
    if (envKey && env[envKey]) {
        return env[envKey];
    }
    
    // 2. 优先级中等：代码配置
    let codeValue = '';
    if (category === 'telegram') {
        if (key === 'botToken') codeValue = TELEGRAM_BOT_TOKEN;
        else if (key === 'chatId') codeValue = TELEGRAM_CHAT_ID;
    } else if (category === 'auth') {
        if (key === 'password') codeValue = AUTH_PASSWORD;
    }
    
    if (codeValue) {
        return codeValue;
    }
    
    // 3. 优先级最低：网页端设置
    if (!webSettings) {
        webSettings = await getSettingsData(env);
    }
    
    if (category === 'telegram') {
        return webSettings.telegram?.[key] || '';
    } else if (category === 'auth') {
        return webSettings.auth?.[key] || '';
    }
    
    return '';
}

// 检查是否存在外置Telegram配置（环境变量或代码配置）
function hasExternalTelegramConfig(env) {
    // 检查环境变量
    const hasEnvConfig = env.TG_TOKEN && env.TG_ID;
    
    // 检查代码配置
    const hasCodeConfig = TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID;
    
    return {
        hasExternal: hasEnvConfig || hasCodeConfig,
        source: hasEnvConfig ? 'environment' : (hasCodeConfig ? 'code' : 'none'),
        envConfig: hasEnvConfig,
        codeConfig: hasCodeConfig
    };
}

// 检查是否存在外置登录认证配置（环境变量或代码配置）
function hasExternalAuthConfig(env) {
    // 检查环境变量
    const hasEnvConfig = env.PASS && env.PASS.trim() !== '';
    
    // 检查代码配置
    const hasCodeConfig = AUTH_PASSWORD && AUTH_PASSWORD.trim() !== '';
    
    return {
        hasExternal: hasEnvConfig || hasCodeConfig,
        source: hasEnvConfig ? 'environment' : (hasCodeConfig ? 'code' : 'none'),
        envConfig: hasEnvConfig,
        codeConfig: hasCodeConfig
    };
}

// 检查外置配置状态并存储到KV（用于检测配置变化）
async function checkAndStoreExternalConfigState(env) {
    try {
        const externalTelegramConfig = hasExternalTelegramConfig(env);
        const externalAuthConfig = hasExternalAuthConfig(env);
        
        const currentState = {
            telegram: {
                hasExternal: externalTelegramConfig.hasExternal,
                source: externalTelegramConfig.source
            },
            auth: {
                hasExternal: externalAuthConfig.hasExternal,
                source: externalAuthConfig.source
            },
            lastCheck: Date.now()
        };
        
        // 获取之前保存的外置配置状态
        const lastStateData = await env.SERVER_MONITOR?.get('external_config_state');
        const lastState = lastStateData ? JSON.parse(lastStateData) : null;
        
        // 保存当前状态
        await env.SERVER_MONITOR?.put('external_config_state', JSON.stringify(currentState));
        
        // 检查是否有配置从有变为无（表示外置配置被删除）
        let needsCleanup = false;
        
        if (lastState) {
            // Telegram配置从有变为无
            if (lastState.telegram?.hasExternal && !currentState.telegram.hasExternal) {
                needsCleanup = true;
            }
            
            // 认证配置从有变为无
            if (lastState.auth?.hasExternal && !currentState.auth.hasExternal) {
                needsCleanup = true;
            }
        }
        
        return needsCleanup;
    } catch (error) {
        console.error('Error checking external config state:', error);
        return false;
    }
}

// 同步配置状态：当外置配置不存在时，自动清理KV中相应的设置
async function syncConfigurationState(env, forceCleanup = false) {
    try {
        const webSettings = await getSettingsData(env);
        const externalTelegramConfig = hasExternalTelegramConfig(env);
        const externalAuthConfig = hasExternalAuthConfig(env);
        
        let needsUpdate = false;
        const updatedSettings = { ...webSettings };
        
        // 确保设置对象结构完整
        if (!updatedSettings.telegram) {
            updatedSettings.telegram = { enabled: false, botToken: '', chatId: '' };
        }
        if (!updatedSettings.auth) {
            updatedSettings.auth = { enabled: false, password: '' };
        }
        
        // 只有在强制清理模式下才执行清理（表示外置配置刚被删除）
        if (forceCleanup) {
            // 获取上次的外置配置状态来决定清理哪些配置
            const lastStateData = await env.SERVER_MONITOR?.get('external_config_state');
            const lastState = lastStateData ? JSON.parse(lastStateData) : null;
            
            if (lastState) {
                // 只清理原本由外置配置提供的设置
                
                // Telegram配置：如果之前有外置配置，现在没有了，则清理
                if (lastState.telegram?.hasExternal && !externalTelegramConfig.hasExternal) {

                    updatedSettings.telegram = {
                        enabled: false,
                        botToken: '',
                        chatId: ''
                    };
                    needsUpdate = true;
                }
                
                // 认证配置：如果之前有外置配置，现在没有了，则清理
                if (lastState.auth?.hasExternal && !externalAuthConfig.hasExternal) {
                    updatedSettings.auth = {
                        enabled: false,
                        password: ''
                    };
                    needsUpdate = true;
                }
            }
            
            // 如果需要更新，写回KV存储
            if (needsUpdate) {
                await env.SERVER_MONITOR?.put('settings', JSON.stringify(updatedSettings));
            }
        }
        
        return updatedSettings;
    } catch (error) {
        console.error('Error syncing configuration state:', error);
        // 如果同步失败，返回当前设置
        return await getSettingsData(env);
    }
}

// 获取完整配置（合并所有来源）
async function getFullConfig(env, forceSync = false) {
    // 获取配置状态，只在明确需要时强制清理
    const webSettings = await syncConfigurationState(env, forceSync);
    const externalTelegramConfig = hasExternalTelegramConfig(env);
    const externalAuthConfig = hasExternalAuthConfig(env);
    
    return {
        telegram: {
            enabled: externalTelegramConfig.hasExternal || (webSettings.telegram?.enabled || false),
            botToken: await getConfigValue(env, 'telegram', 'botToken', webSettings),
            chatId: await getConfigValue(env, 'telegram', 'chatId', webSettings),
            // 添加配置来源信息
            configSource: externalTelegramConfig
        },
        auth: {
            enabled: externalAuthConfig.hasExternal || (webSettings.auth?.enabled || false),
            password: await getConfigValue(env, 'auth', 'password', webSettings),
            // 添加配置来源信息
            configSource: externalAuthConfig
        },
        globalNotifyDays: webSettings.globalNotifyDays || 14,
        siteTitle: (webSettings.siteTitle && webSettings.siteTitle.trim() !== '') ? webSettings.siteTitle : '服务器到期监控',
        welcomeMessage: (webSettings.welcomeMessage && webSettings.welcomeMessage.trim() !== '') ? webSettings.welcomeMessage : 'Hello!',
        nezhaMonitorUrl: webSettings.nezhaMonitorUrl || '',
        customLogoUrl: webSettings.customLogoUrl || '',
        customDesktopBackgroundUrl: webSettings.customDesktopBackgroundUrl || '',
        customMobileBackgroundUrl: webSettings.customMobileBackgroundUrl || ''
    };
}

// 生成公共的颜色变量定义
function getColorVariables() {
    return `
        /* 全局颜色变量定义 - 浅色模式 */
        :root {
            /* 主色调 */
            --primary-color: #007BFF;
            --primary-dark: #0056b3;
            --primary-light: #4dabf7;
            
            /* 状态颜色 */
            --success-color: #28a745;
            --warning-color: #ffc107;
            --danger-color: #dc3545;
            --info-color: #17a2b8;
            
            /* 中性色 */
            --text-primary: #0C0A09;
            --text-secondary: #78716C;
            --text-secondary-hover: #615c57;
            
            /* 背景色 */
            --bg-primary: #ffffff;
            --bg-secondary: #f8f9fa;
            --bg-light: #f5f6fa;
            --bg-muted: #fafbfc;
            --navbar-bg: transparent;
            --footer-bg: transparent;
            
            /* 背景图启用时的透明背景色 */
            --bg-primary-transparent: rgba(255, 255, 255, 0.75);
            --bg-secondary-transparent: rgba(248, 249, 250, 0.75);
            --navbar-bg-transparent: rgba(255, 255, 255, 0);
            --footer-bg-transparent: rgba(255, 255, 255, 0);
            
            /* 边框色 */
            --border-color: #e1e8ed;
            --border-light: #e9ecef;
            --border-muted: #f1f3f4;
            
            /* 标签颜色（与状态颜色保持一致）*/
            --tag-red: #dc3545;
            --tag-orange: #ffc107;
            --tag-green: #28a745;
            --tag-blue: #007BFF;
            --tag-purple: #9b59b6;
            
            /* 渐变背景 */
            --bg-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            
            /* 阴影色 */
            --shadow-color: rgba(0, 0, 0, 0.1);
            --primary-shadow: rgba(0, 123, 255, 0.3);
            
            /* 交互色 */
            --hover-bg: rgba(0, 123, 255, 0.1);
            --selected-bg: rgba(0, 123, 255, 0.05);
            --selected-border: rgba(0, 123, 255, 0.3);
            
            /* 语义化颜色 */
            --total-server-color: var(--primary-color);
            
            /* 背景图相关 */
            --background-image: none;
            --background-overlay: transparent;
            
            /* Logo颜色适配变量 - 浅色主题 */
            --logo-invert: 0%;
            --logo-saturate: 0%;
            --logo-hue: 0deg;
            --logo-brightness: 1;
            --logo-contrast: 1;
        }

        /* 暗色主题 */
        [data-theme="dark"] {
            /* 主色调 - 使用橙色作为主题色 */
            --primary-color: #ffc107;
            --primary-dark: #d39e00;
            --primary-light: #ffcd39;
            
            /* 状态颜色 */
            --success-color: #40d962;
            --warning-color: #ffc107;
            --danger-color: #ff6b6b;
            --info-color: #4ecdc4;
            
            /* 中性色 */
            --text-primary: #FAFAF9;
            --text-secondary: #D6D3D1;
            --text-secondary-hover: #beb8b4;
            
            /* 背景色 */
            --bg-primary: #1A1C22;
            --bg-secondary: #2d2d2d;
            --bg-light: #343a40;
            --bg-muted: #212529;
            --navbar-bg: transparent;
            --footer-bg: transparent;
            
            /* 背景图启用时的透明背景色 */
            --bg-primary-transparent: rgba(26, 28, 34, 0.75);
            --bg-secondary-transparent: rgba(45, 45, 45, 0.75);
            --navbar-bg-transparent: rgba(26, 28, 34, 0);
            --footer-bg-transparent: rgba(26, 28, 34, 0);
            
            /* 边框色 */
            --border-color: #495057;
            --border-light: #404040;
            --border-muted: #373737;
            
            /* 标签颜色（深色模式下的调整）*/
            --tag-red: #ff6b6b;
            --tag-orange: #ffc107;
            --tag-green: #40d962;
            --tag-blue: #74c0fc;
            --tag-purple: #be4bdb;
            
            /* 渐变背景 */
            --bg-gradient: linear-gradient(135deg, #2d3748 0%, #1a202c 100%);
            
            /* 阴影色 */
            --shadow-color: rgba(0, 0, 0, 0.3);
            --primary-shadow: rgba(255, 193, 7, 0.3);
            
            /* 交互色 */
            --hover-bg: rgba(255, 193, 7, 0.1);
            --selected-bg: rgba(255, 193, 7, 0.05);
            --selected-border: rgba(255, 193, 7, 0.3);
            --shadow-color: rgba(255, 193, 7, 0.3);
            
            /* 语义化颜色 */
            --total-server-color: var(--info-color);
            
            /* 背景图相关 */
            --background-image: none;
            --background-overlay: transparent;
            
            /* 背景图启用时的覆盖层 */
            --background-overlay-enabled: rgba(0, 0, 0, ${DARK_MODE_OVERLAY_OPACITY});
            
            /* Logo颜色适配变量 - 深色主题 */
            --logo-invert: 100%;
            --logo-saturate: 0%;
            --logo-hue: 0deg;
            --logo-brightness: 0.9;
            --logo-contrast: 1.1;
        }
    `;
}

// 生成公共的主题切换CSS样式
function getThemeToggleCSS() {
    return `
        /* 主题切换开关样式 */
        .theme-toggle-container {
            position: absolute;
            top: 20px;
            right: 120px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .theme-toggle-wrapper {
            display: flex;
            align-items: center;
        }

        /* 背景图开关按钮样式 */
        .bg-toggle-btn {
            background: none;
            border: none;
            color: var(--text-primary);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            font-size: 16px;
            outline: none;
            width: 36px;
            height: 36px;
            border-radius: 6px;
        }

        .bg-toggle-btn:hover {
            background: var(--hover-bg);
            color: var(--primary-color);
            transform: scale(1.1);
        }

        .theme-toggle {
            position: relative;
            width: 50px;
            height: 24px;
        }

        .theme-toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .theme-toggle .slider,
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--primary-color);
            transition: 0.3s;
            border-radius: 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 6px;
        }

        .theme-toggle .slider:before,
        .slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: #ffffff;
            transition: 0.3s;
            border-radius: 50%;
            z-index: 3;
        }

        .theme-toggle .slider .sun-icon,
        .theme-toggle .slider .moon-icon,
        .slider .sun-icon,
        .slider .moon-icon {
            position: absolute;
            font-size: 10px;
            line-height: 1;
            pointer-events: none;
            z-index: 2;
        }

        .theme-toggle .slider .sun-icon,
        .slider .sun-icon {
            left: 6px;
            top: 50%;
            transform: translateY(-50%);
            color: #ffffff; /* 固定白色，代表太阳 */
        }

        .theme-toggle .slider .moon-icon,
        .slider .moon-icon {
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
            color: #ffffff; /* 固定白色，与太阳图标保持一致 */
        }

        .theme-toggle input:checked + .slider,
        input:checked + .slider {
            background-color: var(--primary-color);
        }

        .theme-toggle input:checked + .slider:before,
        input:checked + .slider:before {
            transform: translateX(26px);
        }

        /* 深色模式下的主题切换按钮 */
        [data-theme="dark"] .theme-toggle .slider:before,
        [data-theme="dark"] .slider:before {
            background-color: #1A1C22;
        }
    `;
}

// ==========================================
// 9. 引导页面功能
// ==========================================

// 检查KV绑定状态
async function checkKVBinding(env) {
  try {
    if (!env.SERVER_MONITOR) {
      return {
        isValid: false,
        error: 'SERVER_MONITOR KV namespace is not bound',
        message: 'KV存储空间未绑定'
      };
    }
    
    // 尝试访问KV存储
    await env.SERVER_MONITOR.get('test');
    return {
      isValid: true,
      message: 'KV存储空间已正确绑定'
    };
  } catch (error) {
    return {
      isValid: false,
      error: error.message,
      message: 'KV存储空间访问失败'
    };
  }
}

// 检查完整的配置状态
async function checkSetupStatus(env) {
  try {
    const kvStatus = await checkKVBinding(env);
    
    if (!kvStatus.isValid) {
      return new Response(JSON.stringify({
        success: false,
        message: kvStatus.message,
        details: kvStatus.error,
        nextStep: 'bindKV'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 检查是否需要认证配置
    const authRequired = await isAuthRequired(env);
    const config = await getFullConfig(env);
    
    const result = {
      success: true,
      message: '配置检查完成',
      kvBound: true,
      authRequired: authRequired,
      hasAuth: authRequired && (config.auth.password || env.PASS),
      hasTelegram: !!(config.telegram.botToken && config.telegram.chatId),
      nextStep: authRequired ? 'login' : 'dashboard'
    };
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      message: '配置检查失败',
      details: error.message,
      nextStep: 'retry'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 引导页面HTML
function getSetupGuideHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VPS Monitor - 初始化配置</title>
    <link rel="icon" type="image/svg+xml" href="${LOGO_IMAGE_URL}">
    <link rel="stylesheet" href="${ICONFONT_CSS_URL}">
    <script src="${ICONFONT_JS_URL}"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #333;
            line-height: 1.6;
        }
        
        .setup-container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
            padding: 40px;
            max-width: 800px;
            width: 90%;
            margin: 20px;
        }
        
        .setup-header {
            text-align: center;
            margin-bottom: 40px;
        }
        
        .setup-header img {
            width: 64px;
            height: 64px;
            margin-bottom: 16px;
        }
        
        .setup-header h1 {
            color: #2c3e50;
            font-size: 28px;
            margin-bottom: 8px;
        }
        
        .setup-header p {
            color: #7f8c8d;
            font-size: 16px;
        }
        
        .step {
            margin-bottom: 30px;
            padding: 24px;
            border: 1px solid #e1e8ed;
            border-radius: 12px;
            background: #f8fafc;
        }
        
        .step-title {
            display: flex;
            align-items: center;
            font-size: 18px;
            font-weight: 600;
            color: #2c3e50;
            margin-bottom: 16px;
        }
        
        .step-number {
            background: #667eea;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: bold;
            margin-right: 12px;
        }
        
        .step-content {
            color: #555;
            line-height: 1.7;
        }
        
        .code-block {
            background: #2c3e50;
            color: #ecf0f1;
            padding: 16px;
            border-radius: 8px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 14px;
            margin: 12px 0;
            overflow-x: auto;
        }
        
        .config-table {
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
        }
        
        .config-table th,
        .config-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e1e8ed;
        }
        
        .config-table th {
            background: #f1f3f4;
            font-weight: 600;
            color: #2c3e50;
        }
        
        .config-table code {
            background: #f1f3f4;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 13px;
        }
        
        .check-button {
            width: 100%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 16px 24px;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 30px;
        }
        
        .check-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }
        
        .check-button:active {
            transform: translateY(0);
        }
        
        .check-button:disabled {
            background: #bdc3c7;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }
        
        .status-message {
            margin-top: 20px;
            padding: 16px;
            border-radius: 8px;
            font-weight: 500;
            display: none;
        }
        
        .status-success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .status-error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        .status-loading {
            background: #d1ecf1;
            color: #0c5460;
            border: 1px solid #bee5eb;
        }
        
        .loading-spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid #ffffff;
            border-radius: 50%;
            border-top-color: transparent;
            animation: spin 1s ease-in-out infinite;
            margin-right: 8px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .iconfont {
            font-size: 20px;
            margin-right: 8px;
        }
        
        @media (max-width: 768px) {
            .setup-container {
                padding: 24px;
                margin: 10px;
            }
            
            .setup-header h1 {
                font-size: 24px;
            }
            
            .code-block {
                font-size: 12px;
                padding: 12px;
            }
        }
    </style>
</head>
<body>
    <div class="setup-container">
        <div class="setup-header">
            <img src="${LOGO_IMAGE_URL}" alt="VPS Monitor">
            <h1>欢迎使用服务器到期监控系统</h1>
            <p>首次使用需要进行简单配置，请按照以下步骤完成初始化</p>
        </div>
        
        <div class="step">
            <div class="step-title">
                <span class="step-number">1</span>
                <i class="iconfont icon-database"></i>
                绑定 KV 存储空间 (必需)
            </div>
            <div class="step-content">
                <p>在 Cloudflare Workers 控制台中为您的 Worker 绑定 KV 存储空间：</p>
                <ol style="margin: 12px 0 12px 20px;">
                    <li>进入 Cloudflare 控制台 → Workers & Pages</li>
                    <li>找到您的 Worker 项目，点击进入</li>
                    <li>转到 "设置" → "变量"</li>
                    <li>在 "KV 命名空间绑定" 部分点击 "添加绑定"</li>
                    <li>变量名称填写：<code>SERVER_MONITOR</code></li>
                    <li>选择或创建一个 KV 命名空间</li>
                    <li>点击 "保存并部署"</li>
                </ol>
            </div>
        </div>
        
        <div class="step">
            <div class="step-title">
                <span class="step-number">2</span>
                <i class="iconfont icon-setting"></i>
                配置环境变量 (可选)
            </div>
            <div class="step-content">
                <p>根据需要在 "设置" → "变量" → "环境变量" 中添加以下配置：</p>
                <table class="config-table">
                    <thead>
                        <tr>
                            <th>变量名</th>
                            <th>说明</th>
                            <th>示例</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><code>PASS</code></td>
                            <td>登录密码（留空则不启用登录验证）</td>
                            <td>your_password</td>
                        </tr>
                        <tr>
                            <td><code>TG_TOKEN</code></td>
                            <td>Telegram Bot Token（用于到期通知）</td>
                            <td>1234567890:ABC...</td>
                        </tr>
                        <tr>
                            <td><code>TG_ID</code></td>
                            <td>Telegram Chat ID</td>
                            <td>123456789</td>
                        </tr>
                    </tbody>
                </table>
                <p><strong>注意：</strong>环境变量配置后需要重新部署 Worker 才能生效。</p>
            </div>
        </div>
        
        <button class="check-button" onclick="checkConfiguration()">
            <i class="iconfont icon-check"></i>
            检测配置并进入系统
        </button>
        
        <div id="statusMessage" class="status-message"></div>
    </div>

    <script>
        async function checkConfiguration() {
            const button = document.querySelector('.check-button');
            const statusDiv = document.getElementById('statusMessage');
            
            // 设置加载状态
            button.disabled = true;
            button.innerHTML = '<span class="loading-spinner"></span>检测配置中...';
            
            statusDiv.className = 'status-message status-loading';
            statusDiv.style.display = 'block';
            statusDiv.textContent = '正在检测配置状态...';
            
            try {
                const response = await fetch('/api/check-setup');
                const result = await response.json();
                
                if (result.success) {
                    statusDiv.className = 'status-message status-success';
                    statusDiv.innerHTML = '<i class="iconfont icon-check"></i>' + result.message + '，即将跳转...';
                    
                    // 根据配置状态决定跳转目标
                    setTimeout(() => {
                        if (result.nextStep === 'dashboard') {
                            window.location.href = '/dashboard';
                        } else if (result.nextStep === 'login') {
                            window.location.href = '/';
                        } else {
                            window.location.href = '/';
                        }
                    }, 1500);
                } else {
                    statusDiv.className = 'status-message status-error';
                    let errorMessage = '<i class="iconfont icon-close"></i>' + result.message;
                    if (result.details) {
                        errorMessage += '<br><small>详细信息: ' + result.details + '</small>';
                    }
                    statusDiv.innerHTML = errorMessage;
                    
                    // 重置按钮
                    button.disabled = false;
                    button.innerHTML = '<i class="iconfont icon-refresh"></i>重新检测';
                }
            } catch (error) {
                statusDiv.className = 'status-message status-error';
                statusDiv.innerHTML = '<i class="iconfont icon-close"></i>检测失败: ' + error.message;
                
                // 重置按钮
                button.disabled = false;
                button.innerHTML = '<i class="iconfont icon-refresh"></i>重新检测';
            }
        }
    </script>
</body>
</html>`;
}
