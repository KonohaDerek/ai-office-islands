import Foundation
import Security

let service = "com.ai-office.local-settings"
let account = "settings-encryption-key-v1"

func emit(_ value: String) {
    FileHandle.standardOutput.write(Data(value.utf8))
}

func readKey() -> Data? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { return nil }
    return result as? Data
}

if let existing = readKey(), existing.count == 32 {
    emit(existing.base64EncodedString())
    exit(EXIT_SUCCESS)
}

var bytes = [UInt8](repeating: 0, count: 32)
guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    fputs("Unable to generate a keychain encryption key.\n", stderr)
    exit(EXIT_FAILURE)
}
let key = Data(bytes)
let item: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecValueData as String: key,
]
let status = SecItemAdd(item as CFDictionary, nil)
if status == errSecSuccess {
    emit(key.base64EncodedString())
    exit(EXIT_SUCCESS)
}
if status == errSecDuplicateItem, let existing = readKey(), existing.count == 32 {
    emit(existing.base64EncodedString())
    exit(EXIT_SUCCESS)
}
fputs("Unable to store the encryption key in macOS Keychain (\(status)).\n", stderr)
exit(EXIT_FAILURE)
