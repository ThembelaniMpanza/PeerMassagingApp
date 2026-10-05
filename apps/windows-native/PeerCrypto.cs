using System.Security.Cryptography;
using System.IO;
using System.Text;
using System.Text.Json;

namespace IPMessenger.Native;

public static class PeerCrypto
{
    public static string Sha256(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    public static string Fingerprint(string publicKey) => string.Join(':', SHA256.HashData(Encoding.UTF8.GetBytes(publicKey)).Select(b => b.ToString("x2")));
    private static string Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Unurl(string text) => Convert.FromBase64String(text.Replace('-', '+').Replace('_', '/').PadRight((text.Length + 3) / 4 * 4, '='));

    public static string PublicKey(ECDiffieHellman key)
    {
        var p = key.ExportParameters(false);
        return JsonSerializer.Serialize(new { key_ops = Array.Empty<string>(), ext = true, kty = "EC", crv = "P-256", x = Url(p.Q.X!), y = Url(p.Q.Y!) });
    }

    public static byte[] Derive(ECDiffieHellman key, string remoteKey)
    {
        using var doc = JsonDocument.Parse(remoteKey);
        var jwk = doc.RootElement;
        if (jwk.GetProperty("kty").GetString() != "EC" || jwk.GetProperty("crv").GetString() != "P-256") throw new InvalidDataException("Unsupported pairing key");
        var x = Unurl(jwk.GetProperty("x").GetString()!);
        var y = Unurl(jwk.GetProperty("y").GetString()!);
        if (x.Length != 32 || y.Length != 32) throw new InvalidDataException("Invalid pairing key");
        using var remote = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = x, Y = y } });
        // WebCrypto ECDH derives the raw 256-bit shared secret, not a hashed KDF.
        return key.DeriveRawSecretAgreement(remote.PublicKey);
    }

    public static object Encrypt(byte[] key, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var iv = RandomNumberGenerator.GetBytes(12);
        var encrypted = new byte[bytes.Length + 16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(iv, bytes, encrypted.AsSpan(0, bytes.Length), encrypted.AsSpan(bytes.Length));
        return new { ciphertext = Convert.ToBase64String(encrypted), iv = Convert.ToBase64String(iv) };
    }

    public static string Decrypt(byte[] key, JsonElement payload)
    {
        var bytes = Convert.FromBase64String(payload.GetProperty("ciphertext").GetString()!);
        var iv = Convert.FromBase64String(payload.GetProperty("iv").GetString()!);
        if (iv.Length != 12 || bytes.Length < 16) throw new InvalidDataException("Invalid encrypted payload");
        var plain = new byte[bytes.Length - 16];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(iv, bytes.AsSpan(0, plain.Length), bytes.AsSpan(plain.Length), plain);
        return new UTF8Encoding(false, true).GetString(plain);
    }

    public static string Protect(byte[] key) => Convert.ToBase64String(ProtectedData.Protect(key, null, DataProtectionScope.CurrentUser));
    public static byte[] Unprotect(string key) => ProtectedData.Unprotect(Convert.FromBase64String(key), null, DataProtectionScope.CurrentUser);
}
