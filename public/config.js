// 阅读端配置：splash / directory / viewer 三页共用
// 阅读端没有构建步骤，直接 <script src="config.js"></script> 引入即可
//
// SaaS 模式下，DATA_URL 默认走「同源 /api/public/data」—— 阅读端和后端部署在一起，
// 后端直接返 live 数据，无需 publish / OSS 中转。
// 想要换成 OSS / 跨域后端 / 任何 URL，把下面 DATA_URL 填上即可（会覆盖同源默认）。
//
// ⚠️ 不要把 .env / 内网地址 / 测试 token 写到这里。
window.MAG_CONFIG = {
  // DATA_URL: 'https://your-cdn.example.com/data.json',  // 留空 = 同源 /api/public/data
  DEFAULT_TENANT: 'zhuobao'
};
