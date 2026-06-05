// 阅读端配置：splash / directory / viewer 三页共用
// 阅读端没有构建步骤，直接 <script src="config.js"></script> 引入即可
// 生产值：DATA_URL 指向 OSS 上 publish 出来的 data.json
//         DEFAULT_TENANT 是 fallback slug（URL 没有 ?t= 时用）
//
// ⚠️ 不要把 .env / 内网地址 / 测试 token 写到这里。
// ⚠️ 部署时如有需要，build 脚本会替换下面这两个值（用 sed / 字符串替换即可）。
window.MAG_CONFIG = {
  DATA_URL: 'https://openclawbsf.oss-cn-beijing.aliyuncs.com/magazine-admin/data.json',
  DEFAULT_TENANT: 'zhuobao'
};
