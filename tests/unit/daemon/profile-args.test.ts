import { describe, expect, it } from 'vitest';
import { buildPlist } from '../../../src/daemon/launchd';
import {
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentLabel,
  serviceProfileId,
  systemdUnitName,
  windowsTaskName,
} from '../../../src/daemon/paths';
import { buildLauncherCmd } from '../../../src/daemon/schtasks';
import { buildUnit } from '../../../src/daemon/systemd';

describe('profile-scoped daemon paths and arguments', () => {
  it('sanitizes service ids and gives each profile distinct service names and logs', () => {
    expect(() => serviceProfileId('codex dev')).toThrow(/invalid profile name/i);
    expect(serviceProfileId('codex_dev')).toBe('codex_dev');
    expect(launchAgentLabel('codex-dev')).toContain('codex-dev');
    expect(systemdUnitName('claude')).not.toBe(systemdUnitName('codex-dev'));
    expect(windowsTaskName('claude')).not.toBe(windowsTaskName('codex-dev'));
    expect(daemonStdoutPath('claude')).not.toBe(daemonStdoutPath('codex-dev'));
    expect(daemonStderrPath('codex-dev').replace(/\\/g, '/')).toContain(
      '/profiles/codex-dev/logs/daemon/',
    );
  });

  it('pins launchd, systemd, and schtasks launch commands to run --profile', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'codex-dev',
      channelHome: '/tmp/lark-channel-home',
    };

    expect(buildPlist(inputs)).toContain('<string>--profile</string>\n        <string>codex-dev</string>');
    expect(buildPlist(inputs)).toContain('<key>LARK_CHANNEL_HOME</key>\n        <string>/tmp/lark-channel-home</string>');
    expect(buildUnit(inputs)).toContain('run --profile "codex-dev"');
    expect(buildUnit(inputs)).toContain('Environment="LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
    expect(buildLauncherCmd(inputs)).toContain('run --profile "codex-dev"');
    expect(buildLauncherCmd(inputs)).toContain('set "LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
  });

  it('passes captured proxy env through launchd plists', () => {
    const plist = buildPlist({
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'claude',
      channelHome: '/tmp/lark-channel-home',
      env: {
        https_proxy: 'http://127.0.0.1:1087',
        no_proxy: 'localhost,127.0.0.1,.feishu.cn',
        HTTP_PROXY: undefined,
      },
    });

    expect(plist).toContain('<key>https_proxy</key>\n        <string>http://127.0.0.1:1087</string>');
    expect(plist).toContain('<key>no_proxy</key>\n        <string>localhost,127.0.0.1,.feishu.cn</string>');
    expect(plist).not.toContain('<key>HTTP_PROXY</key>');
  });
});
