param([string]$Architectures = 'arm64-v8a,x86_64')

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$android = Join-Path $workspace 'apps/mobile/android'
if (-not (Test-Path -LiteralPath (Join-Path $android 'gradlew.bat'))) {
    throw 'Generate the Android project first: npm --workspace apps/mobile exec -- expo prebuild --platform android'
}
if (-not $env:JAVA_HOME -and (Test-Path -LiteralPath 'C:\Program Files\Android\Android Studio\jbr')) {
    $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$previousNodeEnv = $env:NODE_ENV
$previousMetroRoot = $env:EXPO_NO_METRO_WORKSPACE_ROOT
try {
    $env:NODE_ENV = 'production'
    # Gradle passes index.js relative to apps/mobile; Expo otherwise resolves it at the monorepo root.
    $env:EXPO_NO_METRO_WORKSPACE_ROOT = '1'
    Push-Location $android
    try {
        & .\gradlew.bat :app:assembleRelease "-PreactNativeArchitectures=$Architectures" '-Pexpo.useLegacyPackaging=true' '-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=1024m' --console=plain
        if ($LASTEXITCODE -ne 0) { throw 'Android release build failed' }
    } finally { Pop-Location }
    $version = (Get-Content -Raw -LiteralPath (Join-Path $workspace 'apps/mobile/app.json') | ConvertFrom-Json).expo.version
    $artifacts = Join-Path $workspace '.artifacts'
    New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
    $apk = Join-Path $artifacts "IP-Messenger-$version-android.apk"
    Copy-Item -LiteralPath (Join-Path $android 'app/build/outputs/apk/release/app-release.apk') -Destination $apk -Force
    Get-FileHash -Algorithm SHA256 -LiteralPath $apk
    Write-Output "Standalone test APK: $apk"
} finally {
    $env:NODE_ENV = $previousNodeEnv
    $env:EXPO_NO_METRO_WORKSPACE_ROOT = $previousMetroRoot
}
