--
-- PostgreSQL database dump
--

\restrict fXdmGvtGXtjzAz8IV2eq7K4zOpU3SX9W2hQCBK2ORDajAaWGlvKygPNv6skBQBX

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
92683487-d637-4a1d-b03b-e6092f61b389	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	ERP de Java	FSKOdncmYy1u	08e7f63208c4de63c1ff59053b7fec27e17baf8a5396ba6d9acfb4d669d4f21b	2026-11-07 19:55:48.470246+00	2026-11-07 19:55:50.579336+00	\N	\N
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
a26f3984-908b-4dcc-8805-12b05f6f7e1e	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	TENANT_CREATED	TENANT	4b01b201-42ff-4331-9aa3-565fb6d5b531	{"name": "Empresa creada por Java"}	2026-11-07 19:55:48.297638+00	\N
8f331b07-8747-4932-b4e1-2e52e4c685d7	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	API_KEY_CREATED	API_KEY	92683487-d637-4a1d-b03b-e6092f61b389	{"name": "ERP de Java"}	2026-11-07 19:55:48.470246+00	\N
22421305-6b71-4c9e-9992-7f6027e0d4f8	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	TAXPAYER_CREATED	TAXPAYER	135d9a94-5bce-4bed-b033-fb3c20275fc5	{"ruc": "1799999999001"}	2026-11-07 19:55:48.516747+00	\N
425c7ce2-1e6a-4477-8ad7-429dc2d12d52	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	ESTABLISHMENT_CREATED	ESTABLISHMENT	53c6d916-8842-4a78-9342-2e30f9cfe392	{"code": "001", "taxpayerId": "135d9a94-5bce-4bed-b033-fb3c20275fc5"}	2026-11-07 19:55:48.581276+00	\N
2abfe30b-73b1-4f85-98c7-1a8d43d57f93	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	EMISSION_POINT_CREATED	EMISSION_POINT	0eaea883-8607-45da-9849-029b39575778	{"code": "001", "establishmentId": "53c6d916-8842-4a78-9342-2e30f9cfe392"}	2026-11-07 19:55:48.627242+00	\N
eda0ba3f-e235-45c9-a044-97f360ed6e5a	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	CUSTOMER_CREATED	CUSTOMER	be8447c8-1a49-4a7c-bacd-396454f51373	{"idType": "05"}	2026-11-07 19:55:48.664112+00	\N
1c69abc2-56e1-476b-8d6e-616cf2299613	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	PRODUCT_CREATED	PRODUCT	dd0553ff-372b-4838-94c3-98e8691aaad9	{"sku": "SRV-001"}	2026-11-07 19:55:48.701689+00	\N
9e32cba3-9843-4d55-a744-5deab56741f3	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	CERTIFICATE_UPLOADED	CERTIFICATE	7759b9db-9317-4e2e-805f-cd8701d6bf4c	{"validTo": "2036-11-03T19:55:49Z", "taxpayerId": "135d9a94-5bce-4bed-b033-fb3c20275fc5", "fingerprintSha256": "e45bd198352a0367ffa850f1a63116430418948cc55cadb15e29737268dcbe90"}	2026-11-07 19:55:49.669037+00	\N
e1e6520e-15a2-4ad6-917b-b59e6fbdf2d3	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	PRODUCT_CREATED	PRODUCT	5ce0c62e-0d95-41a0-b7ca-8c4db8044fa5	{"sku": "LIB-001"}	2026-11-07 19:55:49.75292+00	\N
a1266334-7742-4a4a-9c54-af90a381a9a3	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	INVOICE_RESERVED	FISCAL_DOCUMENT	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	{"sequence": 1, "environment": "1"}	2026-11-07 19:55:49.82119+00	\N
429358b3-52e5-403f-8b5b-b90fd5ed6a4c	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	CREDIT_NOTE_RESERVED	FISCAL_DOCUMENT	8f8bc2b9-d69c-454c-9385-261b33bc4632	{"sequence": 1, "environment": "1"}	2026-11-07 19:55:50.168803+00	\N
ae9fc95d-b6ef-44b1-9c7e-1bf9fbba9139	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	CREDIT_NOTE_RESERVED	FISCAL_DOCUMENT	bb40bf12-59f9-498c-814d-bfe0d64285e0	{"sequence": 2, "environment": "1"}	2026-11-07 19:55:50.32179+00	\N
b5b27b6b-af9e-465b-aea8-cc0426202c7c	4b01b201-42ff-4331-9aa3-565fb6d5b531	696ccdee-c954-4ec4-9c8c-2fb6653a7720	DEBIT_NOTE_RESERVED	FISCAL_DOCUMENT	3c503cc5-641f-4d5f-9a76-d166d2051e31	{"sequence": 1, "environment": "1"}	2026-11-07 19:55:50.391281+00	\N
\.


--
-- Data for Name: auth_refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_refresh_tokens (token_hash, session_id, created_at, used_at) FROM stdin;
3e7d55a4c51fc4ba2025e08ce4652e2c7ade4b7032e5e08a9495ae55ae287c93	882fba35-5d88-4223-ac41-a582b3d23134	2026-11-07 19:55:48.122153+00	\N
\.


--
-- Data for Name: auth_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_sessions (id, user_id, created_at, expires_at, last_used_at, revoked_at, revoke_reason) FROM stdin;
882fba35-5d88-4223-ac41-a582b3d23134	696ccdee-c954-4ec4-9c8c-2fb6653a7720	2026-11-07 19:55:48.122153+00	2036-11-04 19:55:48.122153+00	2026-11-07 19:55:48.122153+00	\N	\N
\.


--
-- Data for Name: certificates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.certificates (id, tenant_id, taxpayer_id, subject, issuer, serial_number, fingerprint_sha256, valid_from, valid_to, status, encrypted_p12, encrypted_password, created_by, created_at) FROM stdin;
7759b9db-9317-4e2e-805f-cd8701d6bf4c	4b01b201-42ff-4331-9aa3-565fb6d5b531	135d9a94-5bce-4bed-b033-fb3c20275fc5	CN=Emisor de Java,O=Pruebas,C=EC	CN=Emisor de Java,O=Pruebas,C=EC	1609927165598210986	e45bd198352a0367ffa850f1a63116430418948cc55cadb15e29737268dcbe90	2026-11-06 19:55:49+00	2036-11-03 19:55:49+00	ACTIVE	\\x0110f5750f989cc6757f5176cced0aa820c625f4fe63e6ae08ebdd2a2df8b885849ec45448642e1c1c6fb0a2600fa1f825fc084dbda7386182cc07dc24c6e787000f99b99796a81b427ab703985794e13777bd13a3fa21591b4108fd57fa85e340f5b379edf82ed3ceb91a5464bad8db0515633b97178f2eaf6f5efc518cd5ee0829074872eaf48cd6a6c46e9ccc93170626daf5dc76c8c69ffa5b3ebb6253eb1a89e969cb447306ba5536f337aea73a946a3b434dc7976f61a759329a0081c739bb065fb64e74ff11e782e705e1fa58ce17addc360b0d20bb83e3fc2bffa9dfed853ed44302c981080ece81ac5adf369ed1621163a7a8049594fe6772da4be071b014efb23101e189bc441f7fa605daf0885cc415bf52e5449089cf9dc104a7bd16185ebf165d5852422b5e5196812deb92e4c421c98b8e448c86d62af8638131c9ab7b6bf5186b020c6840bd9eb969acb5b4e292efb13c6da05a571be65d5d4017b7d987cdc87275ac2f6d821f02f7eb11e64611a5e79301f59c888dc2abae0027f6bcfa59bd930a2e03b1266a72e65be98339565e6f6be7bb123e1cb81a8a5540fd10b9cad900ae5092a11abfa8aad10e30a2c06d2f40683980f8a4f0cc2baea2b99ea4cd164445b8be6a97455fcdb3ab2e16e6868cfeb3e8c454a21684c24ddece70cc7210c746353a5e72caa69a0bc4432a4516053e5e6c7cdf271dda109f6d7f3bb08e9a5dc278ce96a60dd11761fd7b57236dc3ad45c91beca015660a0fe192066a0dbb007611a4da22086d9f0356ccb3df9464c5844a014e9c273a559361241a6fabfa3f4ebe2d2405a73a70a90bb74b1dd2e16767da5faa7d2101d3ed10141539b39bbe0253a98c578f4c91eaec8dd28f7c11377f4b57a5e11691d26f333d80a2dade902644c0386b2a09a929abf185e438c3fccff166afc1eb1c36b6c2edaea36922239ffb23cad0da48c9864a49e8db3da699264433a9c254ee11374c1eaec100731fc52733acf0bb44d50730ec7540e1099a60ce2b38ba6dbbaa088fb10444eb3609a486435f927a44719171a5de2694c387a810994bc08e8d22bf77dd4a2531d51e469911f246edef81cc6edb06448361bd6ba4a94938bd117114ef811520bac0f1265deaa78ea441b43241455388c19948418298e9c97bdc4d37af963134f64544c99e13762609c3d5449e7fc9e4f73e60e0f21b69d1dbbc5faa3aebee3aac99c415b040fa72672691d197bea953448b1019a4e2c906b6aa96d176951e748c1b0bb68900fe7a5010996fefbe32a688514847351d6779b5ccb431732e18f63c3fffee3bc157a6e6c031645835deccf1b5db27695fd75e72d42419f35066e97f42797b84fe2d4f1579120064f1899c6b8a2028360b86fab6f4bd9a4404a7fc96f19e92e575a78875ea2d5f86bef75b9692caf90f801af573e052b50eb69c4db1c376849ef569f34d5d00e2f2a325062abf3fb740e3eccdd363da6bf1e43617713270e0ac84360119336d9a3a96c53b589a3a1f43047bbb6045b16b7ffbf642d4a501d73b13b4e442fb1c8ab4f2cd6c8ecaa0e3bca8965a9ef7a0ecded1670529e4c02007db8c273e2f726ace84be4c0cc04c6aa5021ebbedf070be418dcfffa4ce654e7cb482884066849e33079604b525eeb1c77a06e1b20eecc9af778980139fd44bb0ef7617efb24168d9fd24456cf63f7829648e1c8e1c50540e99990295224a080e8b36a9a04872601effc151595ac8193dcfa822c75b9ee0cdb2d94b90de2be4ddf5a7442e4b559df7d6f2a873b2860596a4d6e164e31ace9d22999a78fc4842a6f27157607e01c9c98ac4362abf476882a791285488bbf58e64a5219dcf660cc84f461122aebefb9be413249130eb0dc59fda5d97d25aff5e730b2094432bceee9b5cd058697a42b5ac5ff915844ccc079740ec0773f292238a45bf1fd62e112964a50ec16696ba34177734408dcbb09bef188c16e831ef99f807d2ba0f013edebb5f920ad1da413bc262302e00f1f21360cea12ba0735985c6f689f2747db72d54f45cc2af3f37f5883c904daea2042fa7fa43264c631c68b31a220930ee10897c5ae172361ffd8c19f0f8d73a19c7741b79590327f21317e5baf17feea5efb79592e8bad6a41a179769002a45e0bd7db21dee2d9a170ed98e949b8269ccb6da9b30f546be9b826c73b84538882097d0895dcede5328b78afb17bfb687f70631a131e06ac32ae7bca43f0bdca8e19a6dedc7c35533d7196750e9862b70ada6323f2c4a548856134412d4359d9278ff8cd15d42d00b1e82da6f963c7826bc5ee215c96078eae5cefed7c7a6482f0c19e4a9f00808e2127acf901d98f63020ce611d1848426315c147e4faba06e5c264abd6ba300ce8c16a23e474b430e9dff95833c55892fccd1213c3eee23ae7fcb9871cb1a9258bb9ffeed41481b943f804ea7d5d03a45caac75e62449c6ae2352a62f3f083dd5d9e43b5cc728369fee0c9d41137554feaf9253c97c4c6b52b2b901d0769ffff59a1c217f1935b39afbf03332eedd9b8017afcc398c5d529c26a1fe87cf9f0a57ed3078b9181341c83ce71395b0627f3c4cc1458b78b2658f5d1fb1a121b48af9c243c15a49b3ff18e0de5121c77a3d1e898e2d324aa314cd263893a20a0fa205816132d3cb2b26fb3f2b540b903335b76ea2aec5e13b6a3122a73c1c8c49f91c1ccf4794c07e70bca3e06312a10941bffca33c150b7e48f77a1c6b40aebc613d29d3eaa43c2f41db0d6c99e9913b628032267efe0ffdeec33cfb90ff8e6a5566a84ab9cc169fbdba0f8435dc80ec4430dd1854eb322ae3ff12aa4cd042f5e542e679c80735704931e2cd3e0c168572cc2817c565e0d6ee9c13df0ed0021ed8a7f9447586968bf4e281ddd3d6ae2810e5e4c947de0f737b3fa0c229d17b1f936f41e42970347e9e7dcc39b668e9b66bf02bf8660b2b25d58df1fd0f03db83d17439e33cece2b4000802938bb70fa288a1afce80e18702660cc52a91c39dd75a6167c61ee2734fad19667d39425865366db91565f7c966f9391fbb299f9b4a6b155a5752880c4eeb59dc7684dd2d65f6c8ba089e1d5290e28fab3674c3b32accc2f1dc377698af16910175576bb464476d6dcc81e1f06baef28641763519681bd028b495ab16814f2b1e08865aabe65a34ea872543b20750b19c1a111297a0a3a798be125b5a77f4f75e9eef9e682f83aa6d0074bf1fd864c4a30fe3b61d5a4e844188f7770daf0c4ed63c240a26c7979732dcac2bf14e9e2138d8078e05eeea3ff0bd5ec5f5961c67fcc734ca1429507ea4437ea1ddc34b3ad7cfca1e2ebdce055b5bf5affb86a45bf1bb7408292dfc6071f489628d17001e3ee65132a6ddef5fd63d31ebc0f637009b014f1dee25c08704d0dde8827a5bc84d3620ee719faf37c78f773bf193cb802d5451cc9d9425ded49730460b70ed4a609e2265e95dcb87dbd406ba8721c4637b153dd84cbeb1b788fba0b2dad47f94115af4ee089c6ee63cec087c2a6f91921f7f53398a8b5a8f9db2c66d8fab09c2001bfa6d041036291c89e2ed312433ddbaf64ad02b3a82a92aaf5264598d3cea9d473da9d977a83f06ba8000baf039e55d271f83dd94ce9486d22a9cbe97ede09351ac39397b7e95b7167d4d16d0792f1fdba17f9bc4d12ece6a3b18835519d9183bafd8321a5a91879275b42016f8e1c1f9a6f985528e7f14769b07ed1c0e754fd05028b97a5624cbdbb6f0a25d5d80ead3f99796a9d6bb0525bb24191be14b80d183a183de57913a247a01b3db6e728819a9e6bc39f809d8f299b20010301f801677c5fd6d4aeba051ed1bff2c88f5c3b4547b60f84b82f	\\x0181cc896743731f44cc83748db973eda69144d3b01b00081884d7d3ed3eca83cd94f98fffb8f41a3943bcac5bb591a4e63cbcba2af438561e8a305de93bfcb2c9e742908517aaeb81c2bfa8896dcc1f35098ebcd180be22f3ae5e8a27fbae731410006f1b5bf760e856	696ccdee-c954-4ec4-9c8c-2fb6653a7720	2026-11-07 19:55:49.669037+00
\.


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customers (id, tenant_id, id_type, id_number, name, email, address, phone, created_at, deleted_at, version) FROM stdin;
be8447c8-1a49-4a7c-bacd-396454f51373	4b01b201-42ff-4331-9aa3-565fb6d5b531	05	1712345678	María Pérez	cliente@example.test	\N	\N	2026-11-07 19:55:48.664112+00	\N	0
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
4b01b201-42ff-4331-9aa3-565fb6d5b531	0eaea883-8607-45da-9849-029b39575778	1	01	2	2026-11-07
4b01b201-42ff-4331-9aa3-565fb6d5b531	0eaea883-8607-45da-9849-029b39575778	1	04	3	2026-11-07
4b01b201-42ff-4331-9aa3-565fb6d5b531	0eaea883-8607-45da-9849-029b39575778	1	05	2	2026-11-07
\.


--
-- Data for Name: emission_points; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.emission_points (id, tenant_id, establishment_id, code, enabled, created_at) FROM stdin;
0eaea883-8607-45da-9849-029b39575778	4b01b201-42ff-4331-9aa3-565fb6d5b531	53c6d916-8842-4a78-9342-2e30f9cfe392	001	t	2026-11-07 19:55:48.627242+00
\.


--
-- Data for Name: establishments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.establishments (id, tenant_id, taxpayer_id, code, address, created_at) FROM stdin;
53c6d916-8842-4a78-9342-2e30f9cfe392	4b01b201-42ff-4331-9aa3-565fb6d5b531	135d9a94-5bce-4bed-b033-fb3c20275fc5	001	Av. Amazonas 100, Quito	2026-11-07 19:55:48.581276+00
\.


--
-- Data for Name: fiscal_document_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_document_lines (id, tenant_id, document_id, line_no, product_id, main_code, description, quantity, unit_price, discount, subtotal, tax_code, tax_rate_code, tax_rate, tax_amount) FROM stdin;
79256ddc-30e1-40a6-9bee-fd680fe11748	4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	1	dd0553ff-372b-4838-94c3-98e8691aaad9	SRV-001	Servicio de consultoría	2.000000	10.500000	1.00	20.00	2	4	15.00	3.00
8c5d3559-c744-47f6-930e-9c489a018e35	4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	2	5ce0c62e-0d95-41a0-b7ca-8c4db8044fa5	LIB-001	Libro técnico	3.000000	5.250000	0.00	15.75	2	0	0.00	0.00
\.


--
-- Data for Name: fiscal_document_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_document_payments (tenant_id, document_id, line_no, method_code, amount, term, time_unit) FROM stdin;
4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	1	01	18.75	\N	\N
4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	2	20	20.00	30.00	dias
\.


--
-- Data for Name: fiscal_document_taxes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_document_taxes (tenant_id, document_id, tax_code, rate_code, rate, base, amount) FROM stdin;
4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	2	0	0.00	15.75	0.00
4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	2	4	15.00	20.00	3.00
\.


--
-- Data for Name: fiscal_documents; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_documents (id, tenant_id, taxpayer_id, emission_point_id, customer_id, document_type, schema_version, environment, issuer_ruc, establishment_code, emission_point_code, sequence, access_key, state, issue_date, currency, customer_id_type, customer_id_number, customer_name, customer_address, customer_email, subtotal, total_discount, total_tax, total, created_by, created_at, version, issuer_legal_name, issuer_trade_name, issuer_head_office_address, establishment_address, issuer_accounting_required, issuer_special_taxpayer_code, issuer_withholding_agent_code, issuer_rimpe_regime, provider_ruc, next_attempt_at, attempt_count, authorization_number, authorized_at, replaces_document_id, state_changed_at, content, modified_document_id, modified_doc_code, modified_doc_number, modified_doc_date, issuer_phone, customer_phone) FROM stdin;
bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	4b01b201-42ff-4331-9aa3-565fb6d5b531	135d9a94-5bce-4bed-b033-fb3c20275fc5	0eaea883-8607-45da-9849-029b39575778	be8447c8-1a49-4a7c-bacd-396454f51373	01	\N	1	1799999999001	001	001	1	0711202601179999999900110010010000000015692639610	AUTHORIZED	2026-11-07	USD	05	1712345678	María Pérez	\N	cliente@example.test	35.75	1.00	3.00	38.75	696ccdee-c954-4ec4-9c8c-2fb6653a7720	2026-11-07 19:55:49.82119+00	0	Emisor de Java S.A.	Java	Av. Amazonas 100, Quito	Av. Amazonas 100, Quito	t	5368	\N	EMPRENDEDOR	\N	2026-11-07 20:00:49.82119+00	0	0711202601179999999900110010010000000015692639610	2026-11-07 19:55:50.123456+00	\N	2026-11-07 19:55:49.82119+00	\N	\N	\N	\N	\N	022345678	\N
8f8bc2b9-d69c-454c-9385-261b33bc4632	4b01b201-42ff-4331-9aa3-565fb6d5b531	135d9a94-5bce-4bed-b033-fb3c20275fc5	0eaea883-8607-45da-9849-029b39575778	be8447c8-1a49-4a7c-bacd-396454f51373	04	\N	1	1799999999001	001	001	1	0711202604179999999900110010010000000016345193918	RESERVED	2026-11-07	USD	05	1712345678	María Pérez	\N	cliente@example.test	10.00	0.50	1.50	11.50	696ccdee-c954-4ec4-9c8c-2fb6653a7720	2026-11-07 19:55:50.168803+00	0	Emisor de Java S.A.	Java	Av. Amazonas 100, Quito	Av. Amazonas 100, Quito	t	5368	\N	EMPRENDEDOR	\N	2026-11-07 20:00:50.168803+00	0	\N	\N	\N	2026-11-07 19:55:50.168803+00	{"lines": [{"taxCode": "2", "taxRate": "15.00", "discount": "0.50", "mainCode": "SRV-001", "quantity": "1", "subtotal": "10.00", "productId": "dd0553ff-372b-4838-94c3-98e8691aaad9", "taxAmount": "1.50", "unitPrice": "10.500000", "description": "Servicio de consultoría", "taxRateCode": "4", "invoiceLineNo": 1}], "taxes": [{"base": "10.00", "rate": "15.00", "amount": "1.50", "taxCode": "2", "rateCode": "4"}], "reason": "Devolución parcial"}	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	01	001-001-000000001	2026-11-07	022345678	\N
bb40bf12-59f9-498c-814d-bfe0d64285e0	4b01b201-42ff-4331-9aa3-565fb6d5b531	135d9a94-5bce-4bed-b033-fb3c20275fc5	0eaea883-8607-45da-9849-029b39575778	be8447c8-1a49-4a7c-bacd-396454f51373	04	\N	1	1799999999001	001	001	2	0711202604179999999900110010010000000021487960316	RESERVED	2026-11-07	USD	05	1712345678	María Pérez	\N	cliente@example.test	10.50	0.00	0.00	10.50	696ccdee-c954-4ec4-9c8c-2fb6653a7720	2026-11-07 19:55:50.32179+00	0	Emisor de Java S.A.	Java	Av. Amazonas 100, Quito	Av. Amazonas 100, Quito	t	5368	\N	EMPRENDEDOR	\N	2026-11-07 20:00:50.32179+00	0	\N	\N	\N	2026-11-07 19:55:50.32179+00	{"lines": [{"taxCode": "2", "taxRate": "0.00", "discount": "0", "mainCode": "LIB-001", "quantity": "2", "subtotal": "10.50", "productId": "5ce0c62e-0d95-41a0-b7ca-8c4db8044fa5", "taxAmount": "0.00", "unitPrice": "5.250000", "description": "Libro técnico", "taxRateCode": "0", "invoiceLineNo": null}], "taxes": [{"base": "10.50", "rate": "0.00", "amount": "0.00", "taxCode": "2", "rateCode": "0"}], "reason": "Devolución de una factura en papel"}	\N	01	001-001-000000099	2026-10-01	022345678	\N
3c503cc5-641f-4d5f-9a76-d166d2051e31	4b01b201-42ff-4331-9aa3-565fb6d5b531	135d9a94-5bce-4bed-b033-fb3c20275fc5	0eaea883-8607-45da-9849-029b39575778	be8447c8-1a49-4a7c-bacd-396454f51373	05	\N	1	1799999999001	001	001	1	0711202605179999999900110010010000000012681759114	RESERVED	2026-11-07	USD	05	1712345678	María Pérez	\N	cliente@example.test	7.00	0.00	0.75	7.75	696ccdee-c954-4ec4-9c8c-2fb6653a7720	2026-11-07 19:55:50.391281+00	0	Emisor de Java S.A.	Java	Av. Amazonas 100, Quito	Av. Amazonas 100, Quito	t	5368	\N	EMPRENDEDOR	\N	2026-11-07 20:00:50.391281+00	0	\N	\N	\N	2026-11-07 19:55:50.391281+00	{"taxes": [{"base": "2.00", "rate": "0.00", "amount": "0.00", "taxCode": "2", "rateCode": "0"}, {"base": "5.00", "rate": "15.00", "amount": "0.75", "taxCode": "2", "rateCode": "4"}], "reasons": [{"value": "5.00", "reason": "Intereses de mora", "taxCode": "2", "taxRate": "15.00", "taxAmount": "0.75", "taxRateCode": "4"}, {"value": "2.00", "reason": "Gastos de cobranza", "taxCode": "2", "taxRate": "0.00", "taxAmount": "0.00", "taxRateCode": "0"}], "payments": [{"term": null, "amount": "7.75", "timeUnit": null, "methodCode": "01"}]}	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	01	001-001-000000001	2026-11-07	022345678	\N
\.


--
-- Data for Name: flyway_schema_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.flyway_schema_history (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success) FROM stdin;
1	1	schema registry	SQL	V1__schema_registry.sql	812014979	test	2026-11-07 14:55:38.383079	21	t
2	2	identity tenancy	SQL	V2__identity_tenancy.sql	1059035978	test	2026-11-07 14:55:38.43153	152	t
3	3	catalogs billing	SQL	V3__catalogs_billing.sql	879002973	test	2026-11-07 14:55:38.611943	247	t
4	4	issuer snapshot certificates artifacts	SQL	V4__issuer_snapshot_certificates_artifacts.sql	-1190276012	test	2026-11-07 14:55:38.886104	59	t
5	5	sri transmission	SQL	V5__sri_transmission.sql	300901594	test	2026-11-07 14:55:38.968649	50	t
6	6	archive delivery	SQL	V6__archive_delivery.sql	-10461312	test	2026-11-07 14:55:39.035878	45	t
7	7	production activation	SQL	V7__production_activation.sql	1768594005	test	2026-11-07 14:55:39.097901	8	t
8	8	operational indexes	SQL	V8__operational_indexes.sql	-974741680	test	2026-11-07 14:55:39.123941	18	t
9	9	artifact integrity	SQL	V9__artifact_integrity.sql	460727416	test	2026-11-07 14:55:39.160284	25	t
10	10	team invitations	SQL	V10__team_invitations.sql	-1326548818	test	2026-11-07 14:55:39.202285	39	t
11	11	document replacement	SQL	V11__document_replacement.sql	-1202611449	test	2026-11-07 14:55:39.257374	14	t
12	12	state time and append only audit	SQL	V12__state_time_and_append_only_audit.sql	424163220	test	2026-11-07 14:55:39.285297	19	t
13	13	webhooks	SQL	V13__webhooks.sql	1352317869	test	2026-11-07 14:55:39.319597	74	t
14	14	webhook test and fairness	SQL	V14__webhook_test_and_fairness.sql	1497966659	test	2026-11-07 14:55:39.408169	18	t
15	15	own authentication	SQL	V15__own_authentication.sql	-1760892435	test	2026-11-07 14:55:39.439461	81	t
16	16	api keys	SQL	V16__api_keys.sql	1911195593	test	2026-11-07 14:55:39.537018	30	t
17	17	catalog soft deletion	SQL	V17__catalog_soft_deletion.sql	145051380	test	2026-11-07 14:55:39.58099	22	t
18	18	generic documents	SQL	V18__generic_documents.sql	-978879458	test	2026-11-07 14:55:39.62075	12	t
19	19	phones and payment terms	SQL	V19__phones_and_payment_terms.sql	-1619117491	test	2026-11-07 14:55:39.646802	5	t
\.


--
-- Data for Name: idempotency_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idempotency_records (tenant_id, idempotency_key, request_hash, document_id, created_at) FROM stdin;
4b01b201-42ff-4331-9aa3-565fb6d5b531	java-dump-factura	a85db194a1a941005c2299de65506c1e3aee198d2caff63b6471d68c69c986c7	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	2026-11-07 19:55:49.82119+00
4b01b201-42ff-4331-9aa3-565fb6d5b531	java-dump-nc	5a48ac436c72439cbc2c6f1a7845baaf8046ae78411537ce4cc6a38f917393c9	8f8bc2b9-d69c-454c-9385-261b33bc4632	2026-11-07 19:55:50.168803+00
4b01b201-42ff-4331-9aa3-565fb6d5b531	java-dump-nc-mano	e578bf4ca9ea82482ebf67550723646e4f3c334eb4012d5f8bc8e5ca1e6af47a	bb40bf12-59f9-498c-814d-bfe0d64285e0	2026-11-07 19:55:50.32179+00
4b01b201-42ff-4331-9aa3-565fb6d5b531	java-dump-nd	2d8c33bcb20bac20b739134dd27ae154bf952271b6f01e27d57402f17a2cd74d	3c503cc5-641f-4d5f-9a76-d166d2051e31	2026-11-07 19:55:50.391281+00
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
d341c33e-18d6-4dda-9a7e-868ad9e1e6a7	696ccdee-c954-4ec4-9c8c-2fb6653a7720	4b01b201-42ff-4331-9aa3-565fb6d5b531	OWNER	ACTIVE	2026-11-07 19:55:48.297638+00
\.


--
-- Data for Name: outbox_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.outbox_events (id, tenant_id, aggregate_id, event_type, payload, created_at, dispatched_at) FROM stdin;
0e392e88-383b-4122-8e7f-3817cc992962	4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	DOCUMENT_RESERVED	{"documentId": "bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab"}	2026-11-07 19:55:49.82119+00	\N
5fa8ca3d-9c8c-4fb2-9955-bd68244bfdc6	4b01b201-42ff-4331-9aa3-565fb6d5b531	8f8bc2b9-d69c-454c-9385-261b33bc4632	DOCUMENT_RESERVED	{"documentId": "8f8bc2b9-d69c-454c-9385-261b33bc4632"}	2026-11-07 19:55:50.168803+00	\N
c0991ffb-57c0-4a8e-88db-193b987c0531	4b01b201-42ff-4331-9aa3-565fb6d5b531	bb40bf12-59f9-498c-814d-bfe0d64285e0	DOCUMENT_RESERVED	{"documentId": "bb40bf12-59f9-498c-814d-bfe0d64285e0"}	2026-11-07 19:55:50.32179+00	\N
80e11bfc-d7c8-4081-9d3d-b0be13455cf5	4b01b201-42ff-4331-9aa3-565fb6d5b531	3c503cc5-641f-4d5f-9a76-d166d2051e31	DOCUMENT_RESERVED	{"documentId": "3c503cc5-641f-4d5f-9a76-d166d2051e31"}	2026-11-07 19:55:50.391281+00	\N
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
dd0553ff-372b-4838-94c3-98e8691aaad9	4b01b201-42ff-4331-9aa3-565fb6d5b531	SRV-001	Servicio de consultoría	10.500000	2	4	2026-11-07 19:55:48.701689+00	\N	0
5ce0c62e-0d95-41a0-b7ca-8c4db8044fa5	4b01b201-42ff-4331-9aa3-565fb6d5b531	LIB-001	Libro técnico	5.250000	2	0	2026-11-07 19:55:49.75292+00	\N	0
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
6bb701b6-ad58-4651-a657-dcfab52eeba0	4b01b201-42ff-4331-9aa3-565fb6d5b531	bae8b2bd-ec3e-4ac3-b438-6fd9f86a07ab	\N	RESERVED	\N	2026-11-07 19:55:50.082287+00
03b78d71-b5c4-4d07-a241-98b617ff07b1	4b01b201-42ff-4331-9aa3-565fb6d5b531	8f8bc2b9-d69c-454c-9385-261b33bc4632	\N	RESERVED	\N	2026-11-07 19:55:50.287063+00
0666c856-e5db-4f4a-9771-3bbcd76ca596	4b01b201-42ff-4331-9aa3-565fb6d5b531	bb40bf12-59f9-498c-814d-bfe0d64285e0	\N	RESERVED	\N	2026-11-07 19:55:50.342495+00
451c4fa1-313f-435b-86fc-ddd7690a8b76	4b01b201-42ff-4331-9aa3-565fb6d5b531	3c503cc5-641f-4d5f-9a76-d166d2051e31	\N	RESERVED	\N	2026-11-07 19:55:50.440148+00
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
135d9a94-5bce-4bed-b033-fb3c20275fc5	4b01b201-42ff-4331-9aa3-565fb6d5b531	1799999999001	Emisor de Java S.A.	Java	Av. Amazonas 100, Quito	\N	1	2026-11-07 19:55:48.516747+00	t	5368	\N	EMPRENDEDOR	\N	\N	022345678
\.


--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenants (id, name, status, created_at) FROM stdin;
4b01b201-42ff-4331-9aa3-565fb6d5b531	Empresa creada por Java	ACTIVE	2026-11-07 19:55:48.297638+00
\.


--
-- Data for Name: user_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_tokens (id, user_id, purpose, token_hash, created_at, expires_at, used_at) FROM stdin;
7aa1aa60-75d1-4414-a96b-f17b4f3e5864	696ccdee-c954-4ec4-9c8c-2fb6653a7720	VERIFY_EMAIL	e141e15aaddf154158854203e58e5deb798e33050cc25c860929bd63206ea063	2026-11-07 19:55:47.475822+00	2026-11-08 19:55:47.475822+00	\N
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, email, created_at, password_hash, email_verified_at) FROM stdin;
696ccdee-c954-4ec4-9c8c-2fb6653a7720	java-e9ae8e5d@example.test	2026-11-07 19:55:47.475822+00	$argon2id$v=19$m=16384,t=2,p=1$Sn/wfH6R3TdKO6Lok8CDzg$rJ9S7f+l4Bp5xvazJp13zu4MSRtz7QZmfX/09P4TbE0	\N
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

\unrestrict fXdmGvtGXtjzAz8IV2eq7K4zOpU3SX9W2hQCBK2ORDajAaWGlvKygPNv6skBQBX

