package cn.grasswood.workbench;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.Set;

public final class MainActivity extends Activity {
    private static final String PREFERENCES = "workbench";
    private static final String SERVER_URL = "server_url";
    private static final int GREEN = Color.rgb(7, 88, 59);
    private static final int DISCOVERY_PORT = 3003;
    private static final String DISCOVERY_QUERY = "GRASSWOOD_DISCOVER_V1";
    private static final String DISCOVERY_RESPONSE = "GRASSWOOD_WORKBENCH_V1:";
    private static final String LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK";
    private static final int LOCAL_NETWORK_PERMISSION_REQUEST = 1;
    private WebView webView;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(LOCAL_NETWORK_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{LOCAL_NETWORK_PERMISSION}, LOCAL_NETWORK_PERMISSION_REQUEST);
        } else {
            showAddressForm(savedUrl(), true, null);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCAL_NETWORK_PERMISSION_REQUEST) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        showAddressForm(
            savedUrl(),
            granted,
            granted ? null : "需要允许本地网络权限，App 才能连接电脑工作台。"
        );
    }

    private String savedUrl() {
        return getPreferences(MODE_PRIVATE).getString(SERVER_URL, "");
    }

    private void showAddressForm(String currentUrl, boolean discoverOnOpen, String errorMessage) {
        LinearLayout page = column(24);
        page.setGravity(Gravity.CENTER_HORIZONTAL);

        ImageView mascot = new ImageView(this);
        mascot.setImageResource(R.drawable.nahida_avatar);
        mascot.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        int mascotHeight = Math.round(150 * getResources().getDisplayMetrics().density);

        TextView title = text("连接电脑工作台", 26, GREEN);
        title.setGravity(Gravity.CENTER);
        TextView help = text("手机和电脑需连接同一 Wi-Fi。请输入电脑当前的局域网地址，例如 http://192.168.1.23:3002", 16, Color.DKGRAY);
        help.setGravity(Gravity.CENTER);
        help.setPadding(0, 20, 0, 20);
        TextView error = text(errorMessage == null ? "" : errorMessage, 14, Color.rgb(170, 41, 41));
        error.setGravity(Gravity.CENTER);

        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setHint("http://电脑IP:3002");
        address.setText(currentUrl);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);

        Button connect = new Button(this);
        connect.setText("进入工作台");
        connect.setOnClickListener(view -> {
            String url = normalizePrivateUrl(address.getText().toString());
            if (url == null) {
                address.setError("请输入局域网 HTTP 地址，例如 http://192.168.1.23:3002");
                return;
            }
            getPreferences(MODE_PRIVATE).edit().putString(SERVER_URL, url).apply();
            showWorkbench(url);
        });

        Button discover = new Button(this);
        discover.setText("自动发现电脑工作台");
        discover.setOnClickListener(view -> {
            discover.setEnabled(false);
            discover.setText("正在局域网中查找…");
            new Thread(() -> {
                String url = discoverWorkbench();
                runOnUiThread(() -> {
                    discover.setEnabled(true);
                    discover.setText("自动发现电脑工作台");
                    if (url == null) {
                        address.setError("没有找到工作台，请确认电脑端已启动且连接同一 Wi-Fi");
                        return;
                    }
                    getPreferences(MODE_PRIVATE).edit().putString(SERVER_URL, url).apply();
                    showWorkbench(url);
                });
            }).start();
        });

        page.addView(mascot, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, mascotHeight));
        page.addView(title, matchWrap());
        page.addView(help, matchWrap());
        page.addView(error, matchWrap());
        page.addView(address, matchWrap());
        page.addView(discover, matchWrap());
        page.addView(connect, matchWrap());
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setFitsSystemWindows(true);
        scroll.addView(page, matchWrap());
        setContentView(scroll);
        if (discoverOnOpen) discover.performClick();
    }

    private void showWorkbench(String url) {
        LinearLayout page = column(0);
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(18, 8, 12, 8);
        bar.setBackgroundColor(GREEN);

        TextView title = text("草木知讯", 18, Color.WHITE);
        Button change = new Button(this);
        change.setText("更换地址");
        change.setOnClickListener(view -> showAddressForm(url, false, null));
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        bar.addView(change, wrapWrap());

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setUseWideViewPort(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setTextZoom(100);
        webView.setBackgroundColor(Color.rgb(241, 248, 233));
        String origin = Uri.parse(url).getAuthority();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !origin.equals(request.getUrl().getAuthority());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showAddressForm(url, false, "连接失败：" + error.getDescription() + "。请确认电脑工作台已启动。");
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                showAddressForm(url, false, "手机 WebView 渲染失败，请更新 Android System WebView 后重试。");
                return true;
            }
        });
        webView.loadUrl(url);

        page.addView(bar, matchWrap());
        page.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        page.setFitsSystemWindows(true);
        setContentView(page);
    }

    static String normalizePrivateUrl(String value) {
        String candidate = value.trim();
        if (!candidate.endsWith("/")) candidate += "/";
        Uri uri = Uri.parse(candidate);
        if (!"http".equals(uri.getScheme()) || uri.getHost() == null) return null;
        String host = uri.getHost();
        if (!(host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("127."))) {
            if (!host.startsWith("172.")) return null;
            String[] parts = host.split("\\.");
            if (parts.length != 4) return null;
            try {
                int second = Integer.parseInt(parts[1]);
                if (second < 16 || second > 31) return null;
            } catch (NumberFormatException error) {
                return null;
            }
        }
        return uri.toString();
    }

    private String discoverWorkbench() {
        byte[] query = DISCOVERY_QUERY.getBytes(StandardCharsets.UTF_8);
        byte[] buffer = new byte[128];
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(2500);
            Set<InetAddress> broadcasts = new LinkedHashSet<>();
            broadcasts.add(InetAddress.getByName("255.255.255.255"));
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                for (InterfaceAddress address : interfaces.nextElement().getInterfaceAddresses()) {
                    if (address.getBroadcast() != null) broadcasts.add(address.getBroadcast());
                }
            }
            for (InetAddress broadcast : broadcasts) {
                try {
                    socket.send(new DatagramPacket(query, query.length, broadcast, DISCOVERY_PORT));
                } catch (Exception ignored) {
                    // 某些虚拟网卡不允许广播，继续尝试其他活动网卡。
                }
            }
            DatagramPacket response = new DatagramPacket(buffer, buffer.length);
            socket.receive(response);
            String message = new String(
                response.getData(),
                response.getOffset(),
                response.getLength(),
                StandardCharsets.UTF_8
            );
            if (!message.startsWith(DISCOVERY_RESPONSE)) return null;
            int port = Integer.parseInt(message.substring(DISCOVERY_RESPONSE.length()));
            if (port < 1 || port > 65535) return null;
            return normalizePrivateUrl("http://" + response.getAddress().getHostAddress() + ":" + port);
        } catch (Exception error) {
            return null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    private LinearLayout column(int paddingDp) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(paddingDp * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        layout.setBackgroundColor(Color.rgb(241, 248, 233));
        return layout;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private static LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private static LinearLayout.LayoutParams wrapWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }
}
