import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("安卓工作台", () => {
  it("只连接局域网地址且不把管理令牌写入应用", async () => {
    const activity = await readFile(
      new URL("../android-app/app/src/main/java/cn/grasswood/workbench/MainActivity.java", import.meta.url),
      "utf8",
    );
    const manifest = await readFile(
      new URL("../android-app/app/src/main/AndroidManifest.xml", import.meta.url),
      "utf8",
    );
    const buildScript = await readFile(
      new URL("../android-app/build-apk.ps1", import.meta.url),
      "utf8",
    );
    expect(activity).toContain('host.startsWith("10.")');
    expect(activity).toContain('host.startsWith("192.168.")');
    expect(activity).toContain("setAllowFileAccess(false)");
    expect(activity).toContain("setDomStorageEnabled(true)");
    expect(activity).toContain("R.drawable.nahida_avatar");
    expect(activity).toContain("GRASSWOOD_DISCOVER_V1");
    expect(activity).toContain("discover.performClick()");
    expect(activity).toContain("address.getBroadcast()");
    expect(activity).toContain("request.isForMainFrame()");
    expect(manifest).toContain("android.permission.ACCESS_LOCAL_NETWORK");
    expect(activity).toContain("requestPermissions(new String[]{LOCAL_NETWORK_PERMISSION}");
    expect(activity).toContain("onRequestPermissionsResult");
    expect(activity).toContain("Build.VERSION.SDK_INT >= 37");
    expect(activity).toContain("onRenderProcessGone");
    expect(activity).not.toContain("Intent.ACTION_VIEW");
    expect(activity).not.toContain("浏览器打开");
    expect(activity).toContain("setLoadWithOverviewMode(true)");
    expect(activity).toContain("new ScrollView(this)");
    expect(activity).toContain("http://192.168.1.23:3002");
    expect(activity).not.toContain("10.104.229.77");
    expect(activity).not.toContain("ADMIN_TOKEN");
    expect(manifest).toContain("android.permission.INTERNET");
    expect(manifest).toContain('android:allowBackup="false"');
    expect(buildScript).toContain(".debug\\grasswood-debug.keystore");
    expect(buildScript).toContain("--version-code 4 --version-name 1.0.3");
  });
});
