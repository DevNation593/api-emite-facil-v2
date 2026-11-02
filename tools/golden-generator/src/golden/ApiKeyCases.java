package golden;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.example.einvoice.apikey.ApiKeyCredential;

/** API keys de {@code ApiKeyCredential.generate()}: son aleatorias, lo estable es el formato y la relación valor/hash. */
final class ApiKeyCases {

	private ApiKeyCases() {
	}

	static Map<String, Object> generate() {
		List<Object> cases = new ArrayList<>();
		for (int i = 0; i < 5; i++) {
			ApiKeyCredential.Generated generated = ApiKeyCredential.generate();
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("value", generated.value());
			entry.put("publicId", generated.publicId());
			entry.put("secretHash", generated.secretHash());
			cases.add(entry);
		}
		Map<String, Object> root = new LinkedHashMap<>();
		root.put("cases", cases);
		return root;
	}

}
