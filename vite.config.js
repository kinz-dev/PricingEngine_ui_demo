import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = '/tmp/core/data/configs/configservice/PRICING_ENGINE.json';

function configServiceRead(req, res) {
  fs.readFile(CONFIG_PATH, 'utf8', (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message, code: err.code, path: CONFIG_PATH }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(data);
  });
}

function configServiceWrite(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      // Validate JSON and pretty-print
      const parsed = JSON.parse(body);
      const pretty = JSON.stringify(parsed, null, 2);
      fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true }, (mkErr) => {
        if (mkErr) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: mkErr.message, code: mkErr.code, path: CONFIG_PATH }));
          return;
        }
        fs.writeFile(CONFIG_PATH, pretty, 'utf8', (wrErr) => {
          if (wrErr) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: wrErr.message, code: wrErr.code, path: CONFIG_PATH }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true }));
        });
      });
    } catch (e) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Invalid JSON', message: e?.message }));
    }
  });
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'configservice-endpoint',
      configureServer(server) {
        server.middlewares.use('/api/config/pricing-engine', (req, res) => {
          const method = (req.method || 'GET').toUpperCase();
          if (method === 'GET') return configServiceRead(req, res);
          if (method === 'POST' || method === 'PUT') return configServiceWrite(req, res);
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, POST, PUT');
          res.end('Method Not Allowed');
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use('/api/config/pricing-engine', (req, res) => {
          const method = (req.method || 'GET').toUpperCase();
          if (method === 'GET') return configServiceRead(req, res);
          if (method === 'POST' || method === 'PUT') return configServiceWrite(req, res);
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, POST, PUT');
          res.end('Method Not Allowed');
        });
      },
    },
  ],
});
