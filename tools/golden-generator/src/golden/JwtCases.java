package golden;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import com.example.einvoice.identity.AccessTokens;
import com.example.einvoice.identity.AuthProperties;

/** Tokens HS256 emitidos con {@code AccessTokens.issue} y un reloj fijo. El {@code jti} es aleatorio. */
final class JwtCases {

	private static final String SECRET = "golden-test-secret-0123456789-abcdefghijklmnop";

	private static final long BASE_EPOCH_SECONDS = 1_793_000_000L;

	private static final long TTL_SECONDS = 900;

	private JwtCases() {
	}

	static Map<String, Object> generate() {
		Random random = new Random(GoldenGenerator.SEED);
		AuthProperties properties = new AuthProperties(SECRET, URI.create("https://app.example.test"),
				Duration.ofSeconds(TTL_SECONDS), Duration.ofDays(30), Duration.ofHours(24), Duration.ofHours(1), 5,
				Duration.ofMinutes(15), 60, 1);
		String[] emails = { "usuario@example.test", "María.Pérez+facturas@example.test", "ADMIN@Example.Test",
				"ñandu@example.test" };
		List<Object> cases = new ArrayList<>();
		for (int i = 0; i < emails.length; i++) {
			long issuedAt = BASE_EPOCH_SECONDS + i * 3_600L;
			UUID userId = new UUID(random.nextLong(), random.nextLong());
			UUID sessionId = new UUID(random.nextLong(), random.nextLong());
			boolean verified = i % 2 == 0;
			AccessTokens tokens = new AccessTokens(properties, InstantSource.fixed(Instant.ofEpochSecond(issuedAt)));
			AccessTokens.Issued issued = tokens.issue(userId, sessionId, emails[i], verified);
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("userId", userId.toString());
			entry.put("sessionId", sessionId.toString());
			entry.put("email", emails[i]);
			entry.put("emailVerified", verified);
			entry.put("issuedAtEpochSeconds", issuedAt);
			entry.put("ttlSeconds", TTL_SECONDS);
			entry.put("token", issued.value());
			cases.add(entry);
		}
		Map<String, Object> root = new LinkedHashMap<>();
		root.put("secret", SECRET);
		root.put("issuer", AuthProperties.ISSUER);
		root.put("audience", AuthProperties.AUDIENCE);
		root.put("cases", cases);
		return root;
	}

}
