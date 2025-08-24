import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'fs';

const CONFIG_PATH = '/tmp/core/data/configs/configservice/PRICING_ENGINE.json';

function configServiceMiddleware(req, res) {
  fs.readFile(CONFIG_PATH, 'utf8', (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message, code: err.code, path: CONFIG_PATH }));
      return;
    }
    res.statusCode = 200;
    // If the file contains valid JSON, return as-is. If it's not valid JSON, still return text.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(data);
  });
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'configservice-endpoint',
      configureServer(server) {
        server.middlewares.use('/api/config/pricing-engine', (req, res) => {
          if (req.method && req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Allow', 'GET');
            res.end('Method Not Allowed');
            return;
          }
          configServiceMiddleware(req, res);
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use('/api/config/pricing-engine', (req, res) => {
          if (req.method && req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Allow', 'GET');
            res.end('Method Not Allowed');
            return;
          }
          configServiceMiddleware(req, res);
        });
      },
    },
  ],
});
