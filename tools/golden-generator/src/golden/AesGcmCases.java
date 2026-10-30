package golden;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import com.example.einvoice.certificate.AesGcmSecretCipher;
import com.example.einvoice.certificate.CertificateService;
import com.example.einvoice.support.TestCertificates;

/** Secretos cifrados con la clave maestra y el contexto (AAD) que usa cada servicio de la API Java. */
final class AesGcmCases {

	private AesGcmCases() {
	}

	static Map<String, Object> generate() throws Exception {
		Random random = new Random(GoldenGenerator.SEED);
		byte[] master = new byte[32];
		random.nextBytes(master);
		String masterKey = Base64.getEncoder().encodeToString(master);
		AesGcmSecretCipher cipher = new AesGcmSecretCipher(masterKey);

		UUID tenant = uuid(random);
		UUID taxpayer = uuid(random);
		UUID certificate = uuid(random);
		UUID otherCertificate = uuid(random);
		UUID subscription = uuid(random);

		byte[] p12 = TestCertificates.valid();
		byte[] password = TestCertificates.PASSWORD.getBytes(StandardCharsets.UTF_8);
		byte[] oneByte = { (byte) (1 + random.nextInt(255)) };
		byte[] thirtyTwo = new byte[32];
		random.nextBytes(thirtyTwo);
		byte[] webhookSecret = ("whsec_" + Base64.getEncoder().encodeToString(Arrays.copyOf(thirtyTwo, 24)))
			.getBytes(StandardCharsets.UTF_8);

		byte[] p12Context = CertificateService.secretContext(tenant, taxpayer, certificate, "p12");
		byte[] passwordContext = CertificateService.secretContext(tenant, taxpayer, certificate, "password");
		byte[] webhookContext = webhookContext(tenant, subscription);

		List<Object> cases = new ArrayList<>();
		cases.add(entry(cipher, p12Context, p12));
		cases.add(entry(cipher, passwordContext, password));
		cases.add(entry(cipher, webhookContext, webhookSecret));
		cases.add(entry(cipher, p12Context, oneByte));
		cases.add(entry(cipher, passwordContext, thirtyTwo));
		cases.add(entry(cipher, webhookContext, oneByte));
		cases.add(entry(cipher, webhookContext, thirtyTwo));
		cases.add(entry(cipher, CertificateService.secretContext(tenant, taxpayer, otherCertificate, "p12"),
				thirtyTwo));

		Map<String, Object> root = new LinkedHashMap<>();
		root.put("masterKey", masterKey);
		root.put("cases", cases);
		return root;
	}

	/**
	 * {@code WebhookSubscriptionService.secretContext} es privado del paquete: se invoca por reflexión para no
	 * copiar el formato del contexto.
	 */
	private static byte[] webhookContext(UUID tenant, UUID subscription) throws Exception {
		Class<?> type = Class.forName("com.example.einvoice.webhook.WebhookSubscriptionService");
		Method method = type.getDeclaredMethod("secretContext", UUID.class, UUID.class);
		method.setAccessible(true);
		return (byte[]) method.invoke(null, tenant, subscription);
	}

	private static Map<String, Object> entry(AesGcmSecretCipher cipher, byte[] context, byte[] plaintext) {
		byte[] encrypted = cipher.encrypt(plaintext, context);
		if (!Arrays.equals(cipher.decrypt(encrypted, context), plaintext)) {
			throw new IllegalStateException("El cifrado de referencia no descifra a su texto");
		}
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("context", new String(context, StandardCharsets.UTF_8));
		entry.put("plaintext", Base64.getEncoder().encodeToString(plaintext));
		entry.put("ciphertext", Base64.getEncoder().encodeToString(encrypted));
		return entry;
	}

	private static UUID uuid(Random random) {
		return new UUID(random.nextLong(), random.nextLong());
	}

}
