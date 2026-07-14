module.exports = {
  apps: [
    {
      name: "minimal-slack-bot",
      script: "bun",
      args: ["run", "src/index.ts"],
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 15000,
      autorestart: true,
      watch: false,
    },
  ],
};
