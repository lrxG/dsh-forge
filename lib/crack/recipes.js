/**
 * Frida 常用配方。
 *
 * 只提供脚本和落盘，不自动 attach、不自动 spawn。
 * 是否执行、对哪台设备执行，由操作者在 crack 会话里明确决定。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANDROID_SSL = `Java.perform(function () {
  try {
    var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
    var TrustAll = Java.registerClass({
      name: 'com.dshforge.TrustAll',
      implements: [X509TrustManager],
      methods: {
        checkClientTrusted: function () {},
        checkServerTrusted: function () {},
        getAcceptedIssuers: function () { return []; }
      }
    });
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    var init = SSLContext.init.overload(
      '[Ljavax.net.ssl.KeyManager;',
      '[Ljavax.net.ssl.TrustManager;',
      'java.security.SecureRandom'
    );
    init.implementation = function (km, tm, sr) {
      init.call(this, km, [TrustAll.$new()], sr);
    };
    console.log('[ssl] SSLContext trust-all installed');
  } catch (e) {
    console.log('[ssl] SSLContext hook failed: ' + e);
  }

  try {
    var Pinner = Java.use('okhttp3.CertificatePinner');
    Pinner.check.overload('java.lang.String', 'java.util.List').implementation = function () {
      console.log('[ssl] okhttp CertificatePinner bypassed');
    };
  } catch (e) {
    console.log('[ssl] okhttp hook skipped: ' + e);
  }
});
`;

const ANDROID_ROOT = `Java.perform(function () {
  try {
    var File = Java.use('java.io.File');
    File.exists.implementation = function () {
      var p = this.getAbsolutePath();
      if (/su|magisk|busybox|frida|xposed|root/i.test(p)) return false;
      return this.exists();
    };
    console.log('[root] File.exists filter installed');
  } catch (e) {
    console.log('[root] File.exists hook failed: ' + e);
  }

  try {
    Java.use('android.os.Build').TAGS.value = 'release-keys';
    console.log('[root] Build.TAGS set to release-keys');
  } catch (e) {
    console.log('[root] Build.TAGS hook skipped: ' + e);
  }
});
`;

const ANDROID_CRYPTO = `Java.perform(function () {
  function hex(bytes) {
    if (!bytes) return '';
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      var v = (bytes[i] & 0xff).toString(16);
      out.push(v.length === 1 ? '0' + v : v);
    }
    return out.join('');
  }

  try {
    var Cipher = Java.use('javax.crypto.Cipher');
    Cipher.doFinal.overload('[B').implementation = function (input) {
      var output = this.doFinal(input);
      console.log('[cipher] ' + this.getAlgorithm() + ' in=' + hex(input) + ' out=' + hex(output));
      return output;
    };
    console.log('[crypto] Cipher.doFinal hooked');
  } catch (e) {
    console.log('[crypto] Cipher hook failed: ' + e);
  }

  try {
    var Digest = Java.use('java.security.MessageDigest');
    Digest.digest.overload('[B').implementation = function (input) {
      var output = this.digest(input);
      console.log('[digest] ' + this.getAlgorithm() + ' in=' + hex(input) + ' out=' + hex(output));
      return output;
    };
    console.log('[crypto] MessageDigest.digest hooked');
  } catch (e) {
    console.log('[crypto] MessageDigest hook failed: ' + e);
  }
});
`;

const IOS_URLSESSION = `if (ObjC.available) {
  try {
    var NSURLSession = ObjC.classes.NSURLSession;
    var method = NSURLSession['- dataTaskWithRequest:completionHandler:'];
    if (!method) throw new Error('dataTaskWithRequest not found');
    Interceptor.attach(method.implementation, {
      onEnter: function (args) {
        try {
          var req = new ObjC.Object(args[2]);
          console.log('[nsurl] ' + req.HTTPMethod() + ' ' + req.URL().absoluteString());
        } catch (e) {
          console.log('[nsurl] request parse failed: ' + e);
        }
      }
    });
    console.log('[nsurl] NSURLSession hooked');
  } catch (e) {
    console.log('[nsurl] hook failed: ' + e);
  }
} else {
  console.log('[nsurl] Objective-C runtime not available');
}
`;

/** @type {Array<{id:string,title:string,description:string,platform:string,mode:string,tags:string[],script:string}>} */
export const RECIPES = [
  {
    id: "android_ssl_pinning_bypass",
    title: "Android SSL pinning bypass",
    description: "Hook SSLContext 与 OkHttp CertificatePinner，绕过常见证书固定。",
    platform: "android",
    mode: "spawn",
    tags: ["ssl", "pinning", "android", "network"],
    script: ANDROID_SSL,
  },
  {
    id: "android_root_detect_bypass",
    title: "Android root detection bypass",
    description: "过滤常见 root 路径并改写 Build.TAGS，用于观察 root 检测后的行为。",
    platform: "android",
    mode: "spawn",
    tags: ["root", "anti-debug", "android"],
    script: ANDROID_ROOT,
  },
  {
    id: "android_crypto_trace",
    title: "Android crypto API trace",
    description: "记录 Cipher.doFinal 与 MessageDigest.digest 的输入输出，用于定位校验算法。",
    platform: "android",
    mode: "spawn",
    tags: ["crypto", "cipher", "android", "trace"],
    script: ANDROID_CRYPTO,
  },
  {
    id: "ios_nsurlsession_trace",
    title: "iOS NSURLSession request trace",
    description: "记录 NSURLSession 的请求方法与 URL；需要可 attach 的 Frida 环境。",
    platform: "ios",
    mode: "spawn",
    tags: ["network", "ios", "trace"],
    script: IOS_URLSESSION,
  },
];

export function listRecipes(platform) {
  const wanted = String(platform || "").trim().toLowerCase();
  return RECIPES
    .filter((recipe) => !wanted || recipe.platform === wanted)
    .map(({ script, ...meta }) => ({ ...meta, script_chars: script.length }));
}

export function getRecipe(id) {
  const key = String(id || "").trim();
  return RECIPES.find((recipe) => recipe.id === key) || null;
}

/** 把配方写入 $DSH_HOME/crack/recipes/<id>.js；返回路径。 */
export function saveRecipe(id, home) {
  const recipe = getRecipe(id);
  if (!recipe) throw new Error("unknown recipe: " + id);
  const root = home || process.env.DSH_HOME || join(homedir(), ".dsh");
  const dir = join(root, "crack", "recipes");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, recipe.id + ".js");
  writeFileSync(file, recipe.script, "utf8");
  return { id: recipe.id, path: file, chars: recipe.script.length };
}
