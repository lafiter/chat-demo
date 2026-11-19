import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__；默认空串走同源（BFF 托管或开发代理） */
  apiOrigin?: string
  /** 默认 API Key，注入为 __API_KEY__，设置里未保存时使用；BFF 模式下为占位符 */
  apiKey?: string
  /** 默认模型 ID，注入为 __MODEL__ */
  model?: string
  /** 开发模式下 API 请求的代理目标（职称评聘助手 BFF） */
  proxyTarget?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 需要经开发服务器转发到 BFF 的路径前缀（聊天、Key 校验、语音、助手配置） */
const API_PROXY_PATHS = ['/anthropic', '/models', '/v1', '/config'] as const

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = '',
  apiKey = 'intranet',
  model = 'glm-5.3',
  proxyTarget = 'http://localhost:8787',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      // 远端 API 不返回跨域响应头，开发模式注入空地址改走开发服务器同源代理
      __API_ORIGIN__: JSON.stringify(dev ? '' : apiOrigin),
      __API_KEY__: JSON.stringify(apiKey),
      __MODEL__: JSON.stringify(model),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: {
    // 监听全部网卡，局域网设备可经本机 IP 访问（192.168.1.18:8090）
    host: '0.0.0.0',
    port: 8090,
    // 浏览器同源请求按路径前缀转发到 BFF，规避跨域限制
    proxy: [{ context: [...API_PROXY_PATHS], target: proxyTarget, changeOrigin: true }],
    ...devServer,
  },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
