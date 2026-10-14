param(
    [string]$SdkRoot = (Join-Path $PSScriptRoot '..\.tools\android-sdk'),
    [string]$JdkRoot = '',
    [string]$WorkRoot = (Join-Path ([System.IO.Path]::GetTempPath()) 'grasswood-android-build')
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appRoot = Join-Path $PSScriptRoot 'app'
$outputRoot = Join-Path $appRoot 'build\outputs\apk\debug'
$buildRoot = $WorkRoot

if (-not $JdkRoot) {
    $JdkRoot = (Get-ChildItem -Directory (Join-Path $projectRoot '.tools\jdk') | Select-Object -First 1).FullName
}
$env:JAVA_HOME = $JdkRoot

$androidJar = Join-Path $SdkRoot 'platforms\android-37\android.jar'
$buildTools = Join-Path $SdkRoot 'build-tools\36.0.0'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$d8 = Join-Path $buildTools 'd8.bat'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$javac = Join-Path $JdkRoot 'bin\javac.exe'
$jar = Join-Path $JdkRoot 'bin\jar.exe'
$keytool = Join-Path $JdkRoot 'bin\keytool.exe'

foreach ($required in @($androidJar, $aapt2, $d8, $zipalign, $apksigner, $javac, $jar, $keytool)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "缺少构建工具：$required"
    }
}

New-Item -ItemType Directory -Force -Path $buildRoot, $outputRoot | Out-Null
$resolvedBuildRoot = (Resolve-Path $buildRoot).Path
if ((Split-Path $resolvedBuildRoot -Leaf) -ne 'grasswood-android-build') {
    throw '拒绝清理预期临时构建目录之外的路径。'
}
Get-ChildItem -LiteralPath $buildRoot -Force | Remove-Item -Recurse -Force

$stagedApp = Join-Path $buildRoot 'src'
Copy-Item -Recurse -LiteralPath (Join-Path $appRoot 'src') -Destination $buildRoot

$compiled = Join-Path $buildRoot 'compiled'
$generated = Join-Path $buildRoot 'generated'
$classes = Join-Path $buildRoot 'classes'
$dex = Join-Path $buildRoot 'dex'
$unsigned = Join-Path $buildRoot 'unsigned.apk'
$aligned = Join-Path $buildRoot 'aligned.apk'
$keystore = Join-Path $PSScriptRoot '.debug\grasswood-debug.keystore'
$temporaryApk = Join-Path $buildRoot 'grasswood-workbench-debug.apk'
$apk = Join-Path $outputRoot 'grasswood-workbench-debug.apk'
New-Item -ItemType Directory -Force -Path $compiled, $generated, $classes, $dex | Out-Null

$resourceFiles = @(Get-ChildItem -Recurse -File -LiteralPath (Join-Path $stagedApp 'main\res') | ForEach-Object FullName)
foreach ($resourceFile in $resourceFiles) {
    & $aapt2 compile -o $compiled $resourceFile
    if ($LASTEXITCODE) { throw "aapt2 compile 失败：$resourceFile" }
}
$compiledResources = @(Get-ChildItem -File -LiteralPath $compiled | ForEach-Object FullName)

& $aapt2 link -o $unsigned -I $androidJar --manifest (Join-Path $stagedApp 'main\AndroidManifest.xml') --java $generated --min-sdk-version 26 --target-sdk-version 37 --version-code 4 --version-name 1.0.3 @compiledResources
if ($LASTEXITCODE) { throw 'aapt2 link 失败。' }

$mainSource = Join-Path $stagedApp 'main\java\cn\grasswood\workbench\MainActivity.java'
$rSource = Join-Path $generated 'cn\grasswood\workbench\R.java'
& $javac -encoding UTF-8 -source 17 -target 17 -classpath $androidJar -d $classes $mainSource $rSource
if ($LASTEXITCODE) { throw 'javac 编译失败。' }

$classFiles = @(Get-ChildItem -Recurse -Filter '*.class' -LiteralPath $classes | ForEach-Object FullName)
& $d8 --lib $androidJar --min-api 26 --output $dex @classFiles
if ($LASTEXITCODE) { throw 'd8 转换失败。' }

& $jar uf $unsigned -C $dex classes.dex
if ($LASTEXITCODE) { throw '写入 classes.dex 失败。' }
& $zipalign -f 4 $unsigned $aligned
if ($LASTEXITCODE) { throw 'zipalign 失败。' }

if (-not (Test-Path -LiteralPath $keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $keystore -Parent) | Out-Null
    & $keytool -genkeypair -noprompt -keystore $keystore -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE) { throw '生成调试签名失败。' }
}
& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android --out $temporaryApk $aligned
if ($LASTEXITCODE) { throw 'APK 签名失败。' }
& $apksigner verify --verbose $temporaryApk
if ($LASTEXITCODE) { throw 'APK 签名校验失败。' }

Copy-Item -Force -LiteralPath $temporaryApk -Destination $apk

Write-Output $apk
