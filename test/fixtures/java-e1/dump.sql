--
-- PostgreSQL database dump
--

\restrict RmS4imgF7HUvI68FHDhzHEu34maZuUXieZ4TK8qCwSOFnOkZLKHx07fBU1TSLC4

-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: reject_artifact_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_artifact_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION 'document_artifacts es de solo inserción' USING ERRCODE = 'integrity_constraint_violation';
END $$;


--
-- Name: reject_change_to_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_change_to_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION '% es de solo inserción', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name character varying(80) NOT NULL,
    public_id character varying(12) NOT NULL,
    secret_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    CONSTRAINT api_keys_check CHECK (((revoked_at IS NULL) = (revoked_by IS NULL))),
    CONSTRAINT api_keys_name_check CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 80))),
    CONSTRAINT api_keys_public_id_check CHECK (((public_id)::text ~ '^[A-Za-z0-9]{12}$'::text)),
    CONSTRAINT api_keys_secret_hash_check CHECK (((secret_hash)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: artifact_integrity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_integrity (
    artifact_id uuid NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    ok boolean NOT NULL
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    actor_id uuid NOT NULL,
    action character varying(60) NOT NULL,
    entity_type character varying(60) NOT NULL,
    entity_id uuid NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    api_key_id uuid
);


--
-- Name: auth_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_refresh_tokens (
    token_hash character varying(64) NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT auth_refresh_tokens_token_hash_check CHECK (((token_hash)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason character varying(30),
    CONSTRAINT auth_sessions_check CHECK (((revoked_at IS NULL) = (revoke_reason IS NULL))),
    CONSTRAINT auth_sessions_revoke_reason_check CHECK (((revoke_reason)::text = ANY ((ARRAY['LOGOUT'::character varying, 'PASSWORD_CHANGED'::character varying, 'PASSWORD_RESET'::character varying, 'TOKEN_REUSED'::character varying])::text[])))
);


--
-- Name: certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certificates (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    taxpayer_id uuid NOT NULL,
    subject text NOT NULL,
    issuer text NOT NULL,
    serial_number text NOT NULL,
    fingerprint_sha256 character varying(64) NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone NOT NULL,
    status character varying(20) NOT NULL,
    encrypted_p12 bytea NOT NULL,
    encrypted_password bytea NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT certificates_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'REPLACED'::character varying])::text[])))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    id_type character varying(2) NOT NULL,
    id_number character varying(20) NOT NULL,
    name text NOT NULL,
    email text,
    address text,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    version bigint DEFAULT 0 NOT NULL
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    channel character varying(20) NOT NULL,
    recipient text NOT NULL,
    status character varying(20) NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    retry_after timestamp with time zone,
    sending_since timestamp with time zone,
    last_error text,
    provider_message_id text,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT deliveries_channel_check CHECK (((channel)::text = 'EMAIL'::text)),
    CONSTRAINT deliveries_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'SENDING'::character varying, 'SENT'::character varying, 'FAILED'::character varying])::text[])))
);


--
-- Name: document_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    kind character varying(30) NOT NULL,
    sha256 character varying(64) NOT NULL,
    content bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_artifacts_kind_check CHECK (((kind)::text = ANY ((ARRAY['XML_UNSIGNED'::character varying, 'XML_SIGNED'::character varying, 'SRI_AUTHORIZATION'::character varying, 'XML_AUTHORIZED'::character varying, 'RIDE_PDF'::character varying])::text[])))
);


--
-- Name: document_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_sequences (
    tenant_id uuid NOT NULL,
    emission_point_id uuid NOT NULL,
    environment character varying(1) NOT NULL,
    document_type character varying(2) NOT NULL,
    next_value bigint DEFAULT 1 NOT NULL,
    last_issue_date date,
    CONSTRAINT document_sequences_environment_check CHECK (((environment)::text = ANY ((ARRAY['1'::character varying, '2'::character varying])::text[]))),
    CONSTRAINT document_sequences_next_value_check CHECK (((next_value >= 1) AND (next_value <= 1000000000)))
);


--
-- Name: emission_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emission_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    establishment_id uuid NOT NULL,
    code character varying(3) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT emission_points_code_check CHECK (((code)::text ~ '^[0-9]{3}$'::text))
);


--
-- Name: establishments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.establishments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    taxpayer_id uuid NOT NULL,
    code character varying(3) NOT NULL,
    address text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT establishments_code_check CHECK (((code)::text ~ '^[0-9]{3}$'::text))
);


--
-- Name: fiscal_document_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_document_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    line_no integer NOT NULL,
    product_id uuid,
    main_code character varying(25) NOT NULL,
    description text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    unit_price numeric(18,6) NOT NULL,
    discount numeric(14,2) NOT NULL,
    subtotal numeric(14,2) NOT NULL,
    tax_code character varying(2) NOT NULL,
    tax_rate_code character varying(4) NOT NULL,
    tax_rate numeric(5,2) NOT NULL,
    tax_amount numeric(14,2) NOT NULL,
    CONSTRAINT fiscal_document_lines_discount_check CHECK ((discount >= (0)::numeric)),
    CONSTRAINT fiscal_document_lines_line_no_check CHECK ((line_no >= 1)),
    CONSTRAINT fiscal_document_lines_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT fiscal_document_lines_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT fiscal_document_lines_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: fiscal_document_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_document_payments (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    line_no integer NOT NULL,
    method_code character varying(2) NOT NULL,
    amount numeric(14,2) NOT NULL,
    term numeric(14,2),
    time_unit character varying(10),
    CONSTRAINT fiscal_document_payments_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT fiscal_document_payments_line_no_check CHECK ((line_no >= 1)),
    CONSTRAINT fiscal_document_payments_term_check CHECK ((term >= (0)::numeric)),
    CONSTRAINT fiscal_document_payments_term_complete CHECK (((term IS NULL) = (time_unit IS NULL))),
    CONSTRAINT fiscal_document_payments_time_unit_check CHECK ((char_length((time_unit)::text) >= 1))
);


--
-- Name: fiscal_document_taxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_document_taxes (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    tax_code character varying(2) NOT NULL,
    rate_code character varying(4) NOT NULL,
    rate numeric(5,2) NOT NULL,
    base numeric(14,2) NOT NULL,
    amount numeric(14,2) NOT NULL
);


--
-- Name: fiscal_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    taxpayer_id uuid NOT NULL,
    emission_point_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    document_type character varying(2) NOT NULL,
    schema_version character varying(12),
    environment character varying(1) NOT NULL,
    issuer_ruc character varying(13) NOT NULL,
    establishment_code character varying(3) NOT NULL,
    emission_point_code character varying(3) NOT NULL,
    sequence integer NOT NULL,
    access_key character varying(49) NOT NULL,
    state character varying(40) NOT NULL,
    issue_date date NOT NULL,
    currency character varying(3) NOT NULL,
    customer_id_type character varying(2) NOT NULL,
    customer_id_number character varying(20) NOT NULL,
    customer_name text NOT NULL,
    customer_address text,
    customer_email text,
    subtotal numeric(14,2),
    total_discount numeric(14,2),
    total_tax numeric(14,2),
    total numeric(14,2),
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    issuer_legal_name text NOT NULL,
    issuer_trade_name text,
    issuer_head_office_address text NOT NULL,
    establishment_address text NOT NULL,
    issuer_accounting_required boolean NOT NULL,
    issuer_special_taxpayer_code character varying(13),
    issuer_withholding_agent_code character varying(8),
    issuer_rimpe_regime character varying(20) NOT NULL,
    provider_ruc character varying(13),
    next_attempt_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    authorization_number character varying(49),
    authorized_at timestamp with time zone,
    replaces_document_id uuid,
    state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    content jsonb,
    modified_document_id uuid,
    modified_doc_code character varying(2),
    modified_doc_number character varying(17),
    modified_doc_date date,
    issuer_phone text,
    customer_phone text,
    CONSTRAINT fiscal_documents_access_key_check CHECK (((access_key)::text ~ '^[0-9]{49}$'::text)),
    CONSTRAINT fiscal_documents_content_by_type CHECK ((((document_type)::text = '01'::text) = (content IS NULL))),
    CONSTRAINT fiscal_documents_environment_check CHECK (((environment)::text = ANY ((ARRAY['1'::character varying, '2'::character varying])::text[]))),
    CONSTRAINT fiscal_documents_invoice_totals CHECK ((((document_type)::text <> '01'::text) OR ((subtotal IS NOT NULL) AND (total_discount IS NOT NULL) AND (total_tax IS NOT NULL)))),
    CONSTRAINT fiscal_documents_modified_complete CHECK ((((modified_doc_code IS NULL) = (modified_doc_number IS NULL)) AND ((modified_doc_code IS NULL) = (modified_doc_date IS NULL)))),
    CONSTRAINT fiscal_documents_modified_doc_code_check CHECK (((modified_doc_code)::text ~ '^[0-9]{2}$'::text)),
    CONSTRAINT fiscal_documents_modified_doc_number_check CHECK (((modified_doc_number)::text ~ '^[0-9]{3}-[0-9]{3}-[0-9]{9}$'::text)),
    CONSTRAINT fiscal_documents_modified_id_needs_data CHECK (((modified_document_id IS NULL) OR (modified_doc_code IS NOT NULL))),
    CONSTRAINT fiscal_documents_modified_not_self CHECK ((modified_document_id <> id)),
    CONSTRAINT fiscal_documents_not_self_replaced CHECK ((replaces_document_id <> id)),
    CONSTRAINT fiscal_documents_provider_ruc_check CHECK (((provider_ruc)::text ~ '^[0-9]{13}$'::text)),
    CONSTRAINT fiscal_documents_sequence_check CHECK (((sequence >= 1) AND (sequence <= 999999999))),
    CONSTRAINT fiscal_documents_total_by_type CHECK ((((document_type)::text = '06'::text) = (total IS NULL))),
    CONSTRAINT fiscal_documents_type_check CHECK (((document_type)::text = ANY ((ARRAY['01'::character varying, '03'::character varying, '04'::character varying, '05'::character varying, '06'::character varying, '07'::character varying])::text[])))
);


--
-- Name: flyway_schema_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flyway_schema_history (
    installed_rank integer NOT NULL,
    version character varying(50),
    description character varying(200) NOT NULL,
    type character varying(20) NOT NULL,
    script character varying(1000) NOT NULL,
    checksum integer,
    installed_by character varying(100) NOT NULL,
    installed_on timestamp without time zone DEFAULT now() NOT NULL,
    execution_time integer NOT NULL,
    success boolean NOT NULL
);


--
-- Name: idempotency_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_records (
    tenant_id uuid NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    request_hash character varying(64) NOT NULL,
    document_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: identification_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identification_types (
    code character varying(2) NOT NULL,
    name text NOT NULL,
    id_number_pattern text NOT NULL,
    final_consumer boolean DEFAULT false NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    role character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memberships_role_check CHECK (((role)::text = ANY ((ARRAY['OWNER'::character varying, 'ADMIN'::character varying, 'BILLER'::character varying, 'AUDITOR'::character varying])::text[]))),
    CONSTRAINT memberships_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'SUSPENDED'::character varying])::text[])))
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    aggregate_id uuid NOT NULL,
    event_type character varying(60) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone
);


--
-- Name: payment_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_methods (
    code character varying(2) NOT NULL,
    name text NOT NULL,
    valid_from date NOT NULL,
    valid_to date
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    sku character varying(25) NOT NULL,
    name text NOT NULL,
    unit_price numeric(18,6) NOT NULL,
    iva_tax_code character varying(2) DEFAULT '2'::character varying NOT NULL,
    iva_rate_code character varying(4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT products_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: schema_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_registry (
    document_type character(2) NOT NULL,
    schema_version character varying(12) NOT NULL,
    resource_path text NOT NULL,
    sha256 character(64) NOT NULL,
    valid_from date,
    valid_to date
);


--
-- Name: sri_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sri_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    operation character varying(20) NOT NULL,
    environment character varying(1) NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    outcome character varying(30),
    sri_status character varying(60),
    http_status integer,
    error_detail text,
    response bytea,
    CONSTRAINT sri_attempts_environment_check CHECK (((environment)::text = ANY ((ARRAY['1'::character varying, '2'::character varying])::text[]))),
    CONSTRAINT sri_attempts_operation_check CHECK (((operation)::text = ANY ((ARRAY['RECEPTION'::character varying, 'AUTHORIZATION'::character varying])::text[])))
);


--
-- Name: sri_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sri_messages (
    attempt_id uuid NOT NULL,
    "position" integer NOT NULL,
    identifier character varying(20),
    message text,
    additional_info text,
    type character varying(30)
);


--
-- Name: state_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    previous_state character varying(40),
    new_state character varying(40) NOT NULL,
    reason text,
    event_time timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tax_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_rates (
    tax_code character varying(2) NOT NULL,
    rate_code character varying(4) NOT NULL,
    description text NOT NULL,
    rate numeric(5,2) NOT NULL,
    CONSTRAINT tax_rates_rate_check CHECK ((rate >= (0)::numeric))
);


--
-- Name: taxpayers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.taxpayers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ruc character varying(13) NOT NULL,
    legal_name text NOT NULL,
    trade_name text,
    head_office_address text NOT NULL,
    provider_ruc character varying(13),
    default_environment character varying(1) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accounting_required boolean DEFAULT false NOT NULL,
    special_taxpayer_code character varying(13),
    withholding_agent_code character varying(8),
    rimpe_regime character varying(20) DEFAULT 'NONE'::character varying NOT NULL,
    production_enabled_at timestamp with time zone,
    production_enabled_by uuid,
    phone text,
    CONSTRAINT taxpayers_default_environment_check CHECK (((default_environment)::text = ANY ((ARRAY['1'::character varying, '2'::character varying])::text[]))),
    CONSTRAINT taxpayers_production_needs_activation CHECK ((((default_environment)::text = '1'::text) OR (production_enabled_at IS NOT NULL))),
    CONSTRAINT taxpayers_provider_ruc_check CHECK (((provider_ruc)::text ~ '^[0-9]{13}$'::text)),
    CONSTRAINT taxpayers_rimpe_regime_check CHECK (((rimpe_regime)::text = ANY ((ARRAY['NONE'::character varying, 'EMPRENDEDOR'::character varying, 'NEGOCIO_POPULAR'::character varying])::text[]))),
    CONSTRAINT taxpayers_ruc_check CHECK (((ruc)::text ~ '^[0-9]{13}$'::text)),
    CONSTRAINT taxpayers_ruc_main_establishment CHECK (((ruc)::text ~ '^[0-9]{10}001$'::text)),
    CONSTRAINT taxpayers_special_taxpayer_code_check CHECK (((special_taxpayer_code)::text ~ '^[A-Za-z0-9]{3,13}$'::text)),
    CONSTRAINT taxpayers_withholding_agent_code_check CHECK (((withholding_agent_code)::text ~ '^[1-9][0-9]{0,7}$'::text))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT tenants_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'SUSPENDED'::character varying])::text[])))
);


--
-- Name: user_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    purpose character varying(20) NOT NULL,
    token_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT user_tokens_purpose_check CHECK (((purpose)::text = ANY ((ARRAY['VERIFY_EMAIL'::character varying, 'RESET_PASSWORD'::character varying])::text[]))),
    CONSTRAINT user_tokens_token_hash_check CHECK (((token_hash)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    password_hash text,
    email_verified_at timestamp with time zone,
    CONSTRAINT users_email_normalized CHECK (((email = lower(email)) AND ((length(email) >= 3) AND (length(email) <= 254)))),
    CONSTRAINT users_password_needs_email CHECK (((password_hash IS NULL) OR (email IS NOT NULL)))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    event_id uuid NOT NULL,
    event_type character varying(40) NOT NULL,
    document_id uuid,
    document_state character varying(30),
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    retry_after timestamp with time zone,
    sending_since timestamp with time zone,
    last_status integer,
    last_error text,
    sent_at timestamp with time zone,
    CONSTRAINT webhook_deliveries_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'SENDING'::character varying, 'SENT'::character varying, 'FAILED'::character varying])::text[]))),
    CONSTRAINT webhook_deliveries_test_has_no_document CHECK (((((event_type)::text = 'webhook.test'::text) = (document_id IS NULL)) AND ((document_id IS NULL) = (document_state IS NULL))))
);


--
-- Name: webhook_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    url text NOT NULL,
    event_types text[] NOT NULL,
    description character varying(200),
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    disabled_reason character varying(40),
    secret bytea NOT NULL,
    previous_secret bytea,
    previous_secret_expires_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    failing_since timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_subscriptions_check CHECK ((((status)::text = 'DISABLED'::text) = (disabled_reason IS NOT NULL))),
    CONSTRAINT webhook_subscriptions_event_types_check CHECK (((cardinality(event_types) >= 1) AND (event_types <@ ARRAY['document.received'::text, 'document.authorized'::text, 'document.rejected'::text, 'document.delivered'::text]))),
    CONSTRAINT webhook_subscriptions_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'DISABLED'::character varying])::text[]))),
    CONSTRAINT webhook_subscriptions_url_check CHECK ((length(url) <= 2048))
);


--
-- Data for Name: api_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.api_keys (id, tenant_id, created_by, name, public_id, secret_hash, created_at, last_used_at, revoked_at, revoked_by) FROM stdin;
94cc28ce-f4b5-48ab-98f0-c9ca4d8ca989	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	ERP de Java	8NXefKgTOAeG	72080704ba1d06ce0b5a2873d1f484e6a9a371781472f025e79cc8ccc9381d4a	2026-11-02 04:12:20.817211+00	2026-11-02 04:12:22.142253+00	\N	\N
\.


--
-- Data for Name: artifact_integrity; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.artifact_integrity (artifact_id, verified_at, ok) FROM stdin;
\.


--
-- Data for Name: audit_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_events (id, tenant_id, actor_id, action, entity_type, entity_id, metadata, created_at, api_key_id) FROM stdin;
a76d3fe3-561a-4dcf-b1ef-b49d68bb51bd	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	TENANT_CREATED	TENANT	9dccd405-e551-4b8d-adfc-d1c83427c75a	{"name": "Empresa creada por Java"}	2026-11-02 04:12:20.692254+00	\N
987e7d42-eacb-4e9c-b787-30ae3c814afa	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	API_KEY_CREATED	API_KEY	94cc28ce-f4b5-48ab-98f0-c9ca4d8ca989	{"name": "ERP de Java"}	2026-11-02 04:12:20.817211+00	\N
6e3a472a-4b9f-4620-bc5c-67650bac798a	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	TAXPAYER_CREATED	TAXPAYER	2cd353d5-c63e-4b62-a3b6-5af932225cc1	{"ruc": "1799999999001"}	2026-11-02 04:12:20.85996+00	\N
d5771de2-3eae-4c2d-a22f-07eb64d7e142	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	ESTABLISHMENT_CREATED	ESTABLISHMENT	cb52bc8b-3802-4b76-8cb0-27aec114d1bf	{"code": "001", "taxpayerId": "2cd353d5-c63e-4b62-a3b6-5af932225cc1"}	2026-11-02 04:12:20.916936+00	\N
ff57d02e-d0ab-42ee-a42e-c944b3f83cbe	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	EMISSION_POINT_CREATED	EMISSION_POINT	485d8b53-b25d-48dc-9144-7e364bd700a7	{"code": "001", "establishmentId": "cb52bc8b-3802-4b76-8cb0-27aec114d1bf"}	2026-11-02 04:12:20.974528+00	\N
007c45b4-b761-4a12-9859-9ecd0cba20b1	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	CUSTOMER_CREATED	CUSTOMER	1fff4588-b7ee-41c6-a33e-191aa2edbf09	{"idType": "05"}	2026-11-02 04:12:21.013049+00	\N
dfac18a4-d9d9-4b1e-9d92-b2cddaa36a7b	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	PRODUCT_CREATED	PRODUCT	5f167274-6897-4854-9bf3-db1559566726	{"sku": "SRV-001"}	2026-11-02 04:12:21.050589+00	\N
4ac117a4-adb9-48f6-8581-37625b556796	9dccd405-e551-4b8d-adfc-d1c83427c75a	0281c65f-3a66-4801-8152-bf5ba0938106	CERTIFICATE_UPLOADED	CERTIFICATE	bd21c684-f2b0-4530-94e9-27b23c398547	{"validTo": "2036-10-29T04:12:21Z", "taxpayerId": "2cd353d5-c63e-4b62-a3b6-5af932225cc1", "fingerprintSha256": "4d785445781b609aae409f715fb28af92d589a084c6e0824c6e924751d48fe9e"}	2026-11-02 04:12:22.043359+00	\N
\.


--
-- Data for Name: auth_refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_refresh_tokens (token_hash, session_id, created_at, used_at) FROM stdin;
10a6cd43a1429e126a002b5e5978d3f1d9ff680826a2fa42c61f3ccec0a5f93b	c0dd0bf1-5767-4508-ae3e-3b6dae6234a3	2026-11-02 04:12:20.570972+00	\N
\.


--
-- Data for Name: auth_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_sessions (id, user_id, created_at, expires_at, last_used_at, revoked_at, revoke_reason) FROM stdin;
c0dd0bf1-5767-4508-ae3e-3b6dae6234a3	0281c65f-3a66-4801-8152-bf5ba0938106	2026-11-02 04:12:20.570972+00	2036-10-30 04:12:20.570972+00	2026-11-02 04:12:20.570972+00	\N	\N
\.


--
-- Data for Name: certificates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.certificates (id, tenant_id, taxpayer_id, subject, issuer, serial_number, fingerprint_sha256, valid_from, valid_to, status, encrypted_p12, encrypted_password, created_by, created_at) FROM stdin;
bd21c684-f2b0-4530-94e9-27b23c398547	9dccd405-e551-4b8d-adfc-d1c83427c75a	2cd353d5-c63e-4b62-a3b6-5af932225cc1	CN=Emisor de Java,O=Pruebas,C=EC	CN=Emisor de Java,O=Pruebas,C=EC	15829630426256871817	4d785445781b609aae409f715fb28af92d589a084c6e0824c6e924751d48fe9e	2026-11-01 04:12:21+00	2036-10-29 04:12:21+00	ACTIVE	\\x013591868042ee8992961c55d744da2fca963b7567bbe343891681ef9ff14beb2f37e0816b7451c546a0fe4e4e4979217a08ccf51938998ae7715b871630b86bc6c9587347510dafb6cf34a675d711c10a74ad647f6b49c50b7430fef6ea572ab38d9aee450ec487a0ed45533cc605da63f7466e16bbfea02e9b893ff818f88a4ef9a2dc66c3b1b74cf1914627118751d72bd71e3c60fda51cc058366603a190fc6d040688350eff5fe8794d51f12b63ab2d8a003afd59f5f1a865a5214c8f6de5af7983d62a6b28d91d3d12d2b7b38d2f0ca34986ff79af119474894d22d37f76ef4920f700427e47a23b5a53bcc78976d6014ac4c5a5e2d29c67146a640346d231af75a15ccc6f4f6fd21fe34f9361489c32d5740986199633e162de3e6e1a22ae1903a7bf761807e8702c00e190e868ef8088949b793028625b0dc725eb1242babf6b35eb6038ea47b314a95dc645e922e29c34b2746858f651ac6df3b8fe9f3fbbf08e2b68672745eecda983e0509c15a118978faaf4594055f33c26f7f027972adf5988cbd0e839706831be69d88bb7ab3b587a7084b3eb7d7e08f7dd0a2d978a2b19ab0859334d51968d915493e75339e2ac81acf5ca6e79379dd0b0dea05c442cca111e99f7bd9237451b627f138a3d2b9cb5e7e13841ded8b24b4d34df5f0ecd16b440faa3b55a837c03290103d1047bfade877b938390271cedac5e9de7d611349050c283607e0cae4e463565bfe749dace5574f394272488a4d2f99b7e011e72ed28cbb6c5eb6807c37b67169ab24194ea8c955e54ca21ddf061ae44c092a5782c6dca5aab511b91faf7f4e84f56caa3ed317307642c0ef80597372ab1516b8bf3a3f97c6bc3f41577354d0bbfcf2e671cda32b3692a209d86fb995387b66b6c3d1c8a3a5e5b7bb2b3c803b8a988662e13e5fc9c5205b6b591fbf637b76f1370151f6bd8eaa6ffdb3f9ebece77b68ac025fd99ff484aac5ea39723cdfc2f001c16e7474c743d8b5bffb9f96bb90e62732db13fd0fdb8964ddc9faaa2b02954349b2e3935e7acdda4a79b1d8baf1adc388584ca7f402206c0c314ce85b8d252c3d77f1fe8145313e00cfaffa866c0e3eba6fefcab96d5159d4262d616f4b2fbc7b846fa739a4d7dd8b2eaf048cb2408c90203f2ed3db90ceaee9e16ab77f3a09e900ca02a8f21fd2142f481eda4e89b0f2ef6596e9986cdd6e2bb3e682a94f29e0dcf222d180f7ef77f8b5ab4bb67abe2753bf194c5187950e6ed67b55816e678d743635896ac44b2a1829a47989de6aeafc013b845b36fff2a0d4dcc288a9428897270b3297b7c7ccd37d9be709699e5196208e49e1d44f0465af6ced50a37809d8bb57d94058f15577de2a17bccee30e03423fe78fba8cdc03a1dd641561d376545656491ea2ceb3bb5c28e10a35f17eab0a987822c588bab396469f745543a44fb31434f8b4663d8fde72498bebebd969df9402c698fe4ba85a7dadce22da50cc962650f404c19904972727bd119692daca733f1756d71ae86f24df14e76c6cc22668d5615c9901d179fdac206c19125091dd402b2e3b3d5ff8310dfd177a6313eb6c79cc869964a9b145da5ac0a2324ed2e9a6b8b0fa37bcc88ac210e4967d77fd59ee38373ab2efbcfbdef5ea9516caac731953d8a2d2b213bdd3fa26d04464348932192aa31dbe87920513a02806b0c1ad246e95265fa588b5da10594fcbe933863a11e25eb9de755f19a9f6dacbda5c2af04f4f2fdf68df633aa615df8d138d7722bf050421a8f9bbb74c375ccb47efc16a168fc5dbf2ae846b48fc3f9e617f9dc34dd0ab821f0be7f23b02c453582db4d44050943d7210f4ad5eeaec62f09814aea8fb6077d09453e1536391250be29ec30d6a1d4ac38b7d2420c5c6705cf7bb0d9ec17ab5ede16bd627a5fbc037eca012137179fad777744f913634db563289b60147960f58045a8d0a2726ae7a5fbaa46efa447352dc76557b0fce58b03fe8d138e5dab838df7939e72f44a3273783ff2497292cc2e06d5b921c70bdae400bdeb2242fc661e7237779e3b1db68fa032a6a607f116e7b0785629d7f036e3efc5510b7a7adf307dac7bb236bab02e2181ed97b0f1631688a7f9c62e779ad11d8b78eb4dc0efb2d5a134fb9529f55ebdac9a8225c8506c1a2cbee6c4dce76faf3249f37d307945c2d16235d5146d54d7a221aa4429ad262ef3a2e321dfbd5d3162be583fe03d26159b4bde9b180def56ac9b82295d8c3fb32360430afe9c99fc3b96619ff05cba8739c1694f639133dbc6f211d40a1c9b808cebe0e99f512353d0627315ea8190f418398c4c5e7b186490f0329201625db7bcea19044e0cbd3a731a288bdc7f735459a872872062a3a8179019bd6ac45f18b78e81c71d4cf86345e775e95244d289a9c67560197b24e201267ffb32a2caf37dc5780dcc13f34443d01772e5bae57b65d73676fbc5df3b27cfc8ca49e75f4e94c7fcaae63f61a151b16784db8c86ab32731528f11c325a5ead8430bcd191bfda757ddb27a8586de06bca86da6764b400fcb6a94103d9fba321e8b4e8a76d88a871792b620b6ade7f34dcf3e7bc8df4b2345f8cf00b17a62b73dcd2eb2f7abec8c0bcdb7d4be25f07f0878ade7fa3d61a923f309b18b99be159c059949ea24172f76fc07c01bf43eaf3202d21481a2386b264cabb666e54f430ef206d04d43490783b4a724d60012c2fadf85791f4e0ff620ec41b118c941389d4111a86e867d37d4a889daed563a66ce642a677168e6744eabb5951614c978a67a50f0f5896cd34e2d5aefd0366f179cb72c9c1c8d35742a3b461246b4edb5461e42f6d32cb8abab32ce8d3b7d79b37cd4b0fcf38a1d5346496d701ec8889b2feab731cf77c296fbb497ead145f4cbe33ebcb590a9984c28062c801b1cc7d16eaf4cbafa5e3c4bc32cdfd1fdb1a54c6474b73514d6dcedcb2f2d80440974e8616f69c6df4105f9ccf2af0dc43440124e22a9f9eb9f3d575a668cc4d0c80696ae6a9b89496308ccd47a7dca1eaf0694aeed5d2a284a934d29617167810f7d77e0c752619369dde9d6e87824af40be03158a1774f010b9717b0a5b20596f05e8bbfc4b839314fcd2b8db60b36d5e2239ff1808cf8f60e4f022651008dab305c6a326e59d9934a38e5c394ef3af4ea7aef550c3d03926547e01be78121cd170e04176c7b966eac52ab78303c681d29082b309559bc81e696915fd16605b99f1010257ce821fddc04064a203d5f6aac51dbe675fcb7642c0efdca5172677574a9a20656b28499c4f807f8fe5f38ce2c7563483cf0a9a81dc21364dd7a6f44ff1048ae0819546ae039d4b4403d184ba8ab4f637b863e16596df57ac2bebe7d0c4f99b24dd8e5867b7772169995bcf4924857e6130449329348c3aa009f0efb2298779221455ec82e148e6ba0b6a761622f32922156be7cd95d4f958184d68057b77aef668bf767431c7447f63786d1e18f56301c6c6c4614ac439a616d6ce721ffae53fb26f94ce03ed18460456f26e421c4926a5fc4bade3b39cdeb2ceb01f5e07c969494c6ccbecce32eb5588d90248f5a7c40e1dce5a85929bf06a22d9696d681853d5b749ca104d175e1b348347091019016ed06a94c08491cafd45fbba3b4d58496b7d2539d5d39a6a074f454db6cdf084bdc983a09585fe89ad55262820b95ee74199f2ff52207a548fd3ec2ec446b821c851fda78b2e706716ef6def3203ba55cdce0b99a68156d4ab0fed4ab0cc24dc1c14ef29fc51d95645d357eb8ba09d95eca2d5f06e0fc97c45fd5c0b5a996255353ef85857699f4c8b95ece5b8813ff018b29f7729d01c07a51f21ef450bd0875bf1867	\\x0169e3372e63044efa88c6b89b731211bc1e752bec63864fe18c57e124d1d6410becab5aaac0d3b62078a9a3da155322d7efe795938074779b1d5c7b4f0ce507d57274d462d554a46f5e98f15118918b14d5b81a2b4662c5d646760fa7f27317393d41adaa819efbc6b9	0281c65f-3a66-4801-8152-bf5ba0938106	2026-11-02 04:12:22.043359+00
\.


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customers (id, tenant_id, id_type, id_number, name, email, address, phone, created_at, deleted_at, version) FROM stdin;
1fff4588-b7ee-41c6-a33e-191aa2edbf09	9dccd405-e551-4b8d-adfc-d1c83427c75a	05	1712345678	María Pérez	cliente@example.test	\N	\N	2026-11-02 04:12:21.013049+00	\N	0
\.


--
-- Data for Name: deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.deliveries (id, tenant_id, document_id, channel, recipient, status, attempt_count, next_attempt_at, retry_after, sending_since, last_error, provider_message_id, requested_by, created_at, sent_at) FROM stdin;
\.


--
-- Data for Name: document_artifacts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.document_artifacts (id, tenant_id, document_id, kind, sha256, content, created_at) FROM stdin;
\.


--
-- Data for Name: document_sequences; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.document_sequences (tenant_id, emission_point_id, environment, document_type, next_value, last_issue_date) FROM stdin;
\.


--
-- Data for Name: emission_points; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.emission_points (id, tenant_id, establishment_id, code, enabled, created_at) FROM stdin;
485d8b53-b25d-48dc-9144-7e364bd700a7	9dccd405-e551-4b8d-adfc-d1c83427c75a	cb52bc8b-3802-4b76-8cb0-27aec114d1bf	001	t	2026-11-02 04:12:20.974528+00
\.


--
-- Data for Name: establishments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.establishments (id, tenant_id, taxpayer_id, code, address, created_at) FROM stdin;
cb52bc8b-3802-4b76-8cb0-27aec114d1bf	9dccd405-e551-4b8d-adfc-d1c83427c75a	2cd353d5-c63e-4b62-a3b6-5af932225cc1	001	Av. Amazonas 100, Quito	2026-11-02 04:12:20.916936+00
\.


--
-- Data for Name: fiscal_document_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_document_lines (id, tenant_id, document_id, line_no, product_id, main_code, description, quantity, unit_price, discount, subtotal, tax_code, tax_rate_code, tax_rate, tax_amount) FROM stdin;
\.


--
-- Data for Name: fiscal_document_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_document_payments (tenant_id, document_id, line_no, method_code, amount, term, time_unit) FROM stdin;
\.


--
-- Data for Name: fiscal_document_taxes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_document_taxes (tenant_id, document_id, tax_code, rate_code, rate, base, amount) FROM stdin;
\.


--
-- Data for Name: fiscal_documents; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_documents (id, tenant_id, taxpayer_id, emission_point_id, customer_id, document_type, schema_version, environment, issuer_ruc, establishment_code, emission_point_code, sequence, access_key, state, issue_date, currency, customer_id_type, customer_id_number, customer_name, customer_address, customer_email, subtotal, total_discount, total_tax, total, created_by, created_at, version, issuer_legal_name, issuer_trade_name, issuer_head_office_address, establishment_address, issuer_accounting_required, issuer_special_taxpayer_code, issuer_withholding_agent_code, issuer_rimpe_regime, provider_ruc, next_attempt_at, attempt_count, authorization_number, authorized_at, replaces_document_id, state_changed_at, content, modified_document_id, modified_doc_code, modified_doc_number, modified_doc_date, issuer_phone, customer_phone) FROM stdin;
\.


--
-- Data for Name: flyway_schema_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.flyway_schema_history (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success) FROM stdin;
1	1	schema registry	SQL	V1__schema_registry.sql	812014979	test	2026-11-01 23:12:14.823043	18	t
2	2	identity tenancy	SQL	V2__identity_tenancy.sql	1059035978	test	2026-11-01 23:12:14.866115	124	t
3	3	catalogs billing	SQL	V3__catalogs_billing.sql	879002973	test	2026-11-01 23:12:15.012589	198	t
4	4	issuer snapshot certificates artifacts	SQL	V4__issuer_snapshot_certificates_artifacts.sql	-1190276012	test	2026-11-01 23:12:15.232051	50	t
5	5	sri transmission	SQL	V5__sri_transmission.sql	300901594	test	2026-11-01 23:12:15.301782	40	t
6	6	archive delivery	SQL	V6__archive_delivery.sql	-10461312	test	2026-11-01 23:12:15.355299	36	t
7	7	production activation	SQL	V7__production_activation.sql	1768594005	test	2026-11-01 23:12:15.406221	6	t
8	8	operational indexes	SQL	V8__operational_indexes.sql	-974741680	test	2026-11-01 23:12:15.4246	14	t
9	9	artifact integrity	SQL	V9__artifact_integrity.sql	460727416	test	2026-11-01 23:12:15.450746	20	t
10	10	team invitations	SQL	V10__team_invitations.sql	-1326548818	test	2026-11-01 23:12:15.484207	32	t
11	11	document replacement	SQL	V11__document_replacement.sql	-1202611449	test	2026-11-01 23:12:15.529905	12	t
12	12	state time and append only audit	SQL	V12__state_time_and_append_only_audit.sql	424163220	test	2026-11-01 23:12:15.554646	16	t
13	13	webhooks	SQL	V13__webhooks.sql	1352317869	test	2026-11-01 23:12:15.585435	63	t
14	14	webhook test and fairness	SQL	V14__webhook_test_and_fairness.sql	1497966659	test	2026-11-01 23:12:15.6622	16	t
15	15	own authentication	SQL	V15__own_authentication.sql	-1760892435	test	2026-11-01 23:12:15.700164	66	t
16	16	api keys	SQL	V16__api_keys.sql	1911195593	test	2026-11-01 23:12:15.782034	27	t
17	17	catalog soft deletion	SQL	V17__catalog_soft_deletion.sql	145051380	test	2026-11-01 23:12:15.822011	18	t
18	18	generic documents	SQL	V18__generic_documents.sql	-978879458	test	2026-11-01 23:12:15.852709	12	t
19	19	phones and payment terms	SQL	V19__phones_and_payment_terms.sql	-1619117491	test	2026-11-01 23:12:15.878981	5	t
\.


--
-- Data for Name: idempotency_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idempotency_records (tenant_id, idempotency_key, request_hash, document_id, created_at) FROM stdin;
\.


--
-- Data for Name: identification_types; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identification_types (code, name, id_number_pattern, final_consumer) FROM stdin;
04	RUC	[0-9]{13}	f
05	CÉDULA	[0-9]{10}	f
06	PASAPORTE	[A-Za-z0-9]{3,20}	f
07	VENTA A CONSUMIDOR FINAL	9{13}	t
08	IDENTIFICACIÓN DEL EXTERIOR	[A-Za-z0-9]{3,20}	f
\.


--
-- Data for Name: memberships; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.memberships (id, user_id, tenant_id, role, status, created_at) FROM stdin;
cc3e66f7-f1ab-4afe-8d32-8be5ad9d1a43	0281c65f-3a66-4801-8152-bf5ba0938106	9dccd405-e551-4b8d-adfc-d1c83427c75a	OWNER	ACTIVE	2026-11-02 04:12:20.692254+00
\.


--
-- Data for Name: outbox_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.outbox_events (id, tenant_id, aggregate_id, event_type, payload, created_at, dispatched_at) FROM stdin;
\.


--
-- Data for Name: payment_methods; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_methods (code, name, valid_from, valid_to) FROM stdin;
01	SIN UTILIZACION DEL SISTEMA FINANCIERO	2013-01-01	\N
15	COMPENSACIÓN DE DEUDAS	2013-01-01	\N
16	TARJETA DE DÉBITO	2016-06-01	\N
17	DINERO ELECTRÓNICO	2016-06-01	\N
18	TARJETA PREPAGO	2016-06-01	\N
19	TARJETA DE CRÉDITO	2016-06-01	\N
20	OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO	2016-06-01	\N
21	ENDOSO DE TÍTULOS	2016-06-01	\N
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.products (id, tenant_id, sku, name, unit_price, iva_tax_code, iva_rate_code, created_at, deleted_at, version) FROM stdin;
5f167274-6897-4854-9bf3-db1559566726	9dccd405-e551-4b8d-adfc-d1c83427c75a	SRV-001	Servicio de consultoría	10.500000	2	4	2026-11-02 04:12:21.050589+00	\N	0
\.


--
-- Data for Name: schema_registry; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_registry (document_type, schema_version, resource_path, sha256, valid_from, valid_to) FROM stdin;
01	1.0.0	xsd/invoice/1.0.0/factura_V1.0.0.xsd	0c2d62f15c9ed03f5e5d3559dc556dd254396396247f3ea919e63473b4299442	\N	\N
01	1.1.0	xsd/invoice/1.1.0/factura_V1.1.0.xsd	62db9bf0ecceb00ef2b7ed136e59224815e5e5e33c77efc6a0552001e052eb8b	\N	\N
01	2.0.0	xsd/invoice/2.0.0/factura_V2.0.0.xsd	cf1bbd68f43d594f51f9983e8ca2d756e7dfc745ae63ec8ea6301c22d05a1479	\N	\N
01	2.1.0	xsd/invoice/2.1.0/factura_V2.1.0.xsd	5f2c37bc1a58bb40e8bbbc366cabe05d5dc199598aeea1561137370f8bd4eace	\N	\N
\.


--
-- Data for Name: sri_attempts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sri_attempts (id, tenant_id, document_id, operation, environment, started_at, completed_at, outcome, sri_status, http_status, error_detail, response) FROM stdin;
\.


--
-- Data for Name: sri_messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sri_messages (attempt_id, "position", identifier, message, additional_info, type) FROM stdin;
\.


--
-- Data for Name: state_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.state_events (id, tenant_id, document_id, previous_state, new_state, reason, event_time) FROM stdin;
\.


--
-- Data for Name: tax_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tax_rates (tax_code, rate_code, description, rate) FROM stdin;
2	0	0%	0.00
2	2	12%	12.00
2	3	14%	14.00
2	4	15%	15.00
2	5	5%	5.00
2	6	No Objeto de Impuesto	0.00
2	7	Exento de IVA	0.00
2	8	IVA diferenciado	8.00
2	10	13%	13.00
\.


--
-- Data for Name: taxpayers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.taxpayers (id, tenant_id, ruc, legal_name, trade_name, head_office_address, provider_ruc, default_environment, created_at, accounting_required, special_taxpayer_code, withholding_agent_code, rimpe_regime, production_enabled_at, production_enabled_by, phone) FROM stdin;
2cd353d5-c63e-4b62-a3b6-5af932225cc1	9dccd405-e551-4b8d-adfc-d1c83427c75a	1799999999001	Emisor de Java S.A.	Java	Av. Amazonas 100, Quito	\N	1	2026-11-02 04:12:20.85996+00	t	5368	\N	EMPRENDEDOR	\N	\N	022345678
\.


--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenants (id, name, status, created_at) FROM stdin;
9dccd405-e551-4b8d-adfc-d1c83427c75a	Empresa creada por Java	ACTIVE	2026-11-02 04:12:20.692254+00
\.


--
-- Data for Name: user_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_tokens (id, user_id, purpose, token_hash, created_at, expires_at, used_at) FROM stdin;
61af4e70-f087-44c8-b80f-47910c3b8e28	0281c65f-3a66-4801-8152-bf5ba0938106	VERIFY_EMAIL	858c67ccefc43d55d9b037ed95938d873f1e5ba4f53cb2e8b7d068c712d4c640	2026-11-02 04:12:20.213586+00	2026-11-03 04:12:20.213586+00	\N
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, email, created_at, password_hash, email_verified_at) FROM stdin;
0281c65f-3a66-4801-8152-bf5ba0938106	java-e3682c44@example.test	2026-11-02 04:12:20.213586+00	$argon2id$v=19$m=16384,t=2,p=1$Od8SOSVPzKYBIMuvU5K1Kg$GqyBKIpJn+QYPKxj8qZKhIqzJ21g/HuD79+sOSJlyhI	\N
\.


--
-- Data for Name: webhook_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.webhook_deliveries (id, tenant_id, subscription_id, event_id, event_type, document_id, document_state, occurred_at, status, attempt_count, next_attempt_at, retry_after, sending_since, last_status, last_error, sent_at) FROM stdin;
\.


--
-- Data for Name: webhook_subscriptions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.webhook_subscriptions (id, tenant_id, url, event_types, description, status, disabled_reason, secret, previous_secret, previous_secret_expires_at, consecutive_failures, failing_since, created_by, created_at) FROM stdin;
\.


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_public_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_public_id_key UNIQUE (public_id);


--
-- Name: artifact_integrity artifact_integrity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_integrity
    ADD CONSTRAINT artifact_integrity_pkey PRIMARY KEY (artifact_id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_refresh_tokens auth_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: certificates certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: customers customers_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: document_artifacts document_artifacts_document_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_artifacts
    ADD CONSTRAINT document_artifacts_document_id_kind_key UNIQUE (document_id, kind);


--
-- Name: document_artifacts document_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_artifacts
    ADD CONSTRAINT document_artifacts_pkey PRIMARY KEY (id);


--
-- Name: document_sequences document_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sequences
    ADD CONSTRAINT document_sequences_pkey PRIMARY KEY (emission_point_id, environment, document_type);


--
-- Name: emission_points emission_points_establishment_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_points
    ADD CONSTRAINT emission_points_establishment_id_code_key UNIQUE (establishment_id, code);


--
-- Name: emission_points emission_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_points
    ADD CONSTRAINT emission_points_pkey PRIMARY KEY (id);


--
-- Name: emission_points emission_points_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_points
    ADD CONSTRAINT emission_points_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: establishments establishments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.establishments
    ADD CONSTRAINT establishments_pkey PRIMARY KEY (id);


--
-- Name: establishments establishments_taxpayer_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.establishments
    ADD CONSTRAINT establishments_taxpayer_id_code_key UNIQUE (taxpayer_id, code);


--
-- Name: establishments establishments_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.establishments
    ADD CONSTRAINT establishments_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: fiscal_document_lines fiscal_document_lines_document_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_lines
    ADD CONSTRAINT fiscal_document_lines_document_id_line_no_key UNIQUE (document_id, line_no);


--
-- Name: fiscal_document_lines fiscal_document_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_lines
    ADD CONSTRAINT fiscal_document_lines_pkey PRIMARY KEY (id);


--
-- Name: fiscal_document_payments fiscal_document_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_payments
    ADD CONSTRAINT fiscal_document_payments_pkey PRIMARY KEY (document_id, line_no);


--
-- Name: fiscal_document_taxes fiscal_document_taxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_taxes
    ADD CONSTRAINT fiscal_document_taxes_pkey PRIMARY KEY (document_id, tax_code, rate_code);


--
-- Name: fiscal_documents fiscal_documents_access_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_access_key_key UNIQUE (access_key);


--
-- Name: fiscal_documents fiscal_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_pkey PRIMARY KEY (id);


--
-- Name: fiscal_documents fiscal_documents_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_sequence_key UNIQUE (emission_point_id, environment, document_type, sequence);


--
-- Name: fiscal_documents fiscal_documents_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: flyway_schema_history flyway_schema_history_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flyway_schema_history
    ADD CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank);


--
-- Name: idempotency_records idempotency_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (tenant_id, idempotency_key);


--
-- Name: identification_types identification_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identification_types
    ADD CONSTRAINT identification_types_pkey PRIMARY KEY (code);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_user_id_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_tenant_id_key UNIQUE (user_id, tenant_id);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (code);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: schema_registry schema_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_registry
    ADD CONSTRAINT schema_registry_pkey PRIMARY KEY (document_type, schema_version);


--
-- Name: sri_attempts sri_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sri_attempts
    ADD CONSTRAINT sri_attempts_pkey PRIMARY KEY (id);


--
-- Name: sri_messages sri_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sri_messages
    ADD CONSTRAINT sri_messages_pkey PRIMARY KEY (attempt_id, "position");


--
-- Name: state_events state_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_events
    ADD CONSTRAINT state_events_pkey PRIMARY KEY (id);


--
-- Name: tax_rates tax_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (tax_code, rate_code);


--
-- Name: taxpayers taxpayers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taxpayers
    ADD CONSTRAINT taxpayers_pkey PRIMARY KEY (id);


--
-- Name: taxpayers taxpayers_ruc_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taxpayers
    ADD CONSTRAINT taxpayers_ruc_key UNIQUE (ruc);


--
-- Name: taxpayers taxpayers_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taxpayers
    ADD CONSTRAINT taxpayers_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: user_tokens user_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tokens
    ADD CONSTRAINT user_tokens_pkey PRIMARY KEY (id);


--
-- Name: user_tokens user_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tokens
    ADD CONSTRAINT user_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_subscription_id_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_subscription_id_event_id_key UNIQUE (subscription_id, event_id);


--
-- Name: webhook_subscriptions webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscriptions webhook_subscriptions_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: customers_identification_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customers_identification_key ON public.customers USING btree (tenant_id, id_type, id_number) WHERE (deleted_at IS NULL);


--
-- Name: flyway_schema_history_s_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flyway_schema_history_s_idx ON public.flyway_schema_history USING btree (success);


--
-- Name: idx_api_keys_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_tenant ON public.api_keys USING btree (tenant_id, created_at DESC);


--
-- Name: idx_artifact_integrity_corrupt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_artifact_integrity_corrupt ON public.artifact_integrity USING btree (artifact_id) WHERE (NOT ok);


--
-- Name: idx_artifact_integrity_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_artifact_integrity_verified ON public.artifact_integrity USING btree (verified_at);


--
-- Name: idx_audit_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_tenant ON public.audit_events USING btree (tenant_id, created_at DESC);


--
-- Name: idx_auth_refresh_tokens_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_refresh_tokens_session ON public.auth_refresh_tokens USING btree (session_id);


--
-- Name: idx_auth_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_sessions_expires ON public.auth_sessions USING btree (expires_at);


--
-- Name: idx_auth_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_sessions_user ON public.auth_sessions USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_certificates_taxpayer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certificates_taxpayer ON public.certificates USING btree (tenant_id, taxpayer_id, created_at DESC);


--
-- Name: idx_deliveries_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliveries_document ON public.deliveries USING btree (document_id, created_at);


--
-- Name: idx_deliveries_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliveries_due ON public.deliveries USING btree (next_attempt_at) WHERE (next_attempt_at IS NOT NULL);


--
-- Name: idx_deliveries_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliveries_open ON public.deliveries USING btree (status) WHERE ((status)::text <> 'SENT'::text);


--
-- Name: idx_fiscal_documents_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fiscal_documents_due ON public.fiscal_documents USING btree (next_attempt_at) WHERE (next_attempt_at IS NOT NULL);


--
-- Name: idx_fiscal_documents_modified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fiscal_documents_modified ON public.fiscal_documents USING btree (modified_document_id) WHERE (modified_document_id IS NOT NULL);


--
-- Name: idx_fiscal_documents_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fiscal_documents_open ON public.fiscal_documents USING btree (state, state_changed_at) WHERE ((state)::text <> 'AUTHORIZED'::text);


--
-- Name: idx_fiscal_documents_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fiscal_documents_tenant_created ON public.fiscal_documents USING btree (tenant_id, created_at DESC, id);


--
-- Name: idx_memberships_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_tenant ON public.memberships USING btree (tenant_id, created_at);


--
-- Name: idx_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_user ON public.memberships USING btree (user_id);


--
-- Name: idx_outbox_events_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_pending ON public.outbox_events USING btree (created_at) WHERE (dispatched_at IS NULL);


--
-- Name: idx_sri_attempts_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sri_attempts_document ON public.sri_attempts USING btree (document_id, started_at);


--
-- Name: idx_state_events_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_events_document ON public.state_events USING btree (document_id, event_time);


--
-- Name: idx_user_tokens_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tokens_expires ON public.user_tokens USING btree (expires_at);


--
-- Name: idx_user_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tokens_user ON public.user_tokens USING btree (user_id, purpose) WHERE (used_at IS NULL);


--
-- Name: idx_webhook_deliveries_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_document ON public.webhook_deliveries USING btree (document_id);


--
-- Name: idx_webhook_deliveries_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_due ON public.webhook_deliveries USING btree (next_attempt_at) WHERE (next_attempt_at IS NOT NULL);


--
-- Name: idx_webhook_deliveries_finished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_finished ON public.webhook_deliveries USING btree (occurred_at) WHERE ((status)::text = ANY ((ARRAY['SENT'::character varying, 'FAILED'::character varying])::text[]));


--
-- Name: idx_webhook_deliveries_sending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_sending ON public.webhook_deliveries USING btree (tenant_id) WHERE ((status)::text = 'SENDING'::text);


--
-- Name: idx_webhook_deliveries_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_subscription ON public.webhook_deliveries USING btree (subscription_id, occurred_at DESC);


--
-- Name: idx_webhook_subscriptions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_subscriptions_tenant ON public.webhook_subscriptions USING btree (tenant_id);


--
-- Name: products_sku_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_sku_key ON public.products USING btree (tenant_id, sku) WHERE (deleted_at IS NULL);


--
-- Name: uq_api_keys_active_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_api_keys_active_name ON public.api_keys USING btree (tenant_id, lower((name)::text)) WHERE (revoked_at IS NULL);


--
-- Name: uq_certificates_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_certificates_active ON public.certificates USING btree (taxpayer_id) WHERE ((status)::text = 'ACTIVE'::text);


--
-- Name: uq_deliveries_automatic; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_deliveries_automatic ON public.deliveries USING btree (document_id, channel) WHERE (requested_by IS NULL);


--
-- Name: uq_fiscal_documents_replaces; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_fiscal_documents_replaces ON public.fiscal_documents USING btree (replaces_document_id) WHERE (replaces_document_id IS NOT NULL);


--
-- Name: uq_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_email ON public.users USING btree (email);


--
-- Name: audit_events audit_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_change_to_append_only();


--
-- Name: audit_events audit_events_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_change_to_append_only();


--
-- Name: document_artifacts document_artifacts_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_artifacts_immutable BEFORE DELETE OR UPDATE ON public.document_artifacts FOR EACH ROW EXECUTE FUNCTION public.reject_artifact_change();


--
-- Name: document_artifacts document_artifacts_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_artifacts_no_truncate BEFORE TRUNCATE ON public.document_artifacts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_artifact_change();


--
-- Name: state_events state_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER state_events_append_only BEFORE DELETE OR UPDATE ON public.state_events FOR EACH ROW EXECUTE FUNCTION public.reject_change_to_append_only();


--
-- Name: state_events state_events_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER state_events_no_truncate BEFORE TRUNCATE ON public.state_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_change_to_append_only();


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: api_keys api_keys_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id);


--
-- Name: api_keys api_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: audit_events audit_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: audit_events audit_events_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id);


--
-- Name: audit_events audit_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: auth_refresh_tokens auth_refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: certificates certificates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: certificates certificates_tenant_id_taxpayer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_tenant_id_taxpayer_id_fkey FOREIGN KEY (tenant_id, taxpayer_id) REFERENCES public.taxpayers(tenant_id, id);


--
-- Name: customers customers_id_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_id_type_fkey FOREIGN KEY (id_type) REFERENCES public.identification_types(code);


--
-- Name: customers customers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: deliveries deliveries_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: deliveries deliveries_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: document_artifacts document_artifacts_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_artifacts
    ADD CONSTRAINT document_artifacts_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: document_sequences document_sequences_tenant_id_emission_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sequences
    ADD CONSTRAINT document_sequences_tenant_id_emission_point_id_fkey FOREIGN KEY (tenant_id, emission_point_id) REFERENCES public.emission_points(tenant_id, id);


--
-- Name: emission_points emission_points_tenant_id_establishment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_points
    ADD CONSTRAINT emission_points_tenant_id_establishment_id_fkey FOREIGN KEY (tenant_id, establishment_id) REFERENCES public.establishments(tenant_id, id);


--
-- Name: establishments establishments_tenant_id_taxpayer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.establishments
    ADD CONSTRAINT establishments_tenant_id_taxpayer_id_fkey FOREIGN KEY (tenant_id, taxpayer_id) REFERENCES public.taxpayers(tenant_id, id);


--
-- Name: fiscal_document_lines fiscal_document_lines_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_lines
    ADD CONSTRAINT fiscal_document_lines_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: fiscal_document_payments fiscal_document_payments_method_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_payments
    ADD CONSTRAINT fiscal_document_payments_method_code_fkey FOREIGN KEY (method_code) REFERENCES public.payment_methods(code);


--
-- Name: fiscal_document_payments fiscal_document_payments_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_payments
    ADD CONSTRAINT fiscal_document_payments_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: fiscal_document_taxes fiscal_document_taxes_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_document_taxes
    ADD CONSTRAINT fiscal_document_taxes_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: fiscal_documents fiscal_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: fiscal_documents fiscal_documents_modified_document_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_modified_document_fkey FOREIGN KEY (tenant_id, modified_document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: fiscal_documents fiscal_documents_replaces_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_replaces_fkey FOREIGN KEY (tenant_id, replaces_document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: fiscal_documents fiscal_documents_tenant_id_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_tenant_id_customer_id_fkey FOREIGN KEY (tenant_id, customer_id) REFERENCES public.customers(tenant_id, id);


--
-- Name: fiscal_documents fiscal_documents_tenant_id_emission_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_tenant_id_emission_point_id_fkey FOREIGN KEY (tenant_id, emission_point_id) REFERENCES public.emission_points(tenant_id, id);


--
-- Name: fiscal_documents fiscal_documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: fiscal_documents fiscal_documents_tenant_id_taxpayer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_tenant_id_taxpayer_id_fkey FOREIGN KEY (tenant_id, taxpayer_id) REFERENCES public.taxpayers(tenant_id, id);


--
-- Name: idempotency_records idempotency_records_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_records
    ADD CONSTRAINT idempotency_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: memberships memberships_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: outbox_events outbox_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: products products_iva_tax_code_iva_rate_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_iva_tax_code_iva_rate_code_fkey FOREIGN KEY (iva_tax_code, iva_rate_code) REFERENCES public.tax_rates(tax_code, rate_code);


--
-- Name: products products_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sri_attempts sri_attempts_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sri_attempts
    ADD CONSTRAINT sri_attempts_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: sri_messages sri_messages_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sri_messages
    ADD CONSTRAINT sri_messages_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES public.sri_attempts(id);


--
-- Name: state_events state_events_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_events
    ADD CONSTRAINT state_events_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: taxpayers taxpayers_production_enabled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taxpayers
    ADD CONSTRAINT taxpayers_production_enabled_by_fkey FOREIGN KEY (production_enabled_by) REFERENCES public.users(id);


--
-- Name: taxpayers taxpayers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taxpayers
    ADD CONSTRAINT taxpayers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: user_tokens user_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tokens
    ADD CONSTRAINT user_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: webhook_deliveries webhook_deliveries_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.fiscal_documents(tenant_id, id);


--
-- Name: webhook_deliveries webhook_deliveries_tenant_id_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_tenant_id_subscription_id_fkey FOREIGN KEY (tenant_id, subscription_id) REFERENCES public.webhook_subscriptions(tenant_id, id) ON DELETE CASCADE;


--
-- Name: webhook_subscriptions webhook_subscriptions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: webhook_subscriptions webhook_subscriptions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- PostgreSQL database dump complete
--

\unrestrict RmS4imgF7HUvI68FHDhzHEu34maZuUXieZ4TK8qCwSOFnOkZLKHx07fBU1TSLC4

