module.exports = {
  apps: [
    {
      name: 'vps-panel',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'vps-bot',
      script: 'bot.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
