-- Local-only admin seed. Replaces upstream database/02-init-admin.sql, which on this
-- snapshot writes app_user.is_protected (a column that exists nowhere in the schema or code) and uses
-- ON CONFLICT (uen) (training_provider has no unique constraint on uen).
-- Reads the same GUCs docker-compose passes to postgres (-c app.admin_email=... etc.).
DO $$
DECLARE
    v_email    TEXT := COALESCE(NULLIF(current_setting('app.admin_email',    true), ''), 'admin@example.com');
    v_password TEXT := COALESCE(NULLIF(current_setting('app.admin_password', true), ''), 'ChangeMe123!');
    v_name     TEXT := COALESCE(NULLIF(current_setting('app.admin_name',     true), ''), 'System Administrator');
    v_company  TEXT := COALESCE(NULLIF(current_setting('app.company_name',   true), ''), 'My Company');
    v_uen      TEXT := COALESCE(NULLIF(current_setting('app.partner_uen',    true), ''), '000000000A');
    v_provider UUID;
    v_user     UUID;
BEGIN
    SELECT id INTO v_provider FROM public.training_provider WHERE uen = v_uen LIMIT 1;
    IF v_provider IS NULL THEN
        INSERT INTO public.training_provider (id, company_name, uen, created_at, updated_at)
        VALUES (gen_random_uuid(), v_company, v_uen, NOW(), NOW())
        RETURNING id INTO v_provider;
    END IF;

    SELECT id INTO v_user FROM public.app_user WHERE LOWER(email) = LOWER(v_email) LIMIT 1;
    IF v_user IS NULL THEN
        -- pgcrypto bf => $2a$ bcrypt hash, which bcryptjs (pages/api/auth/login.ts) verifies
        INSERT INTO public.app_user (id, email, password_hash, full_name, account_status, created_at, updated_at)
        VALUES (gen_random_uuid(), v_email, public.crypt(v_password, public.gen_salt('bf', 10)), v_name, 'active', NOW(), NOW())
        RETURNING id INTO v_user;
    END IF;

    INSERT INTO public.user_role_map (user_id, role)
    SELECT v_user, r::public.user_role
      FROM unnest(ARRAY['Learner','Trainer','Admin','Developer','Training Provider','Finance','Payroll']) AS r
     WHERE NOT EXISTS (SELECT 1 FROM public.user_role_map m WHERE m.user_id = v_user AND m.role::text = r);

    INSERT INTO public.provider_admin_user (provider_id, user_id)
    SELECT v_provider, v_user
     WHERE NOT EXISTS (SELECT 1 FROM public.provider_admin_user p WHERE p.provider_id = v_provider AND p.user_id = v_user);

    -- The column default is the REAL SSG (https://api.ssg-wsg.sg) and training_provider.ssg_api_base_url
    -- wins over the SSG_API_URL env var in credentials-service. Point this install at the local mock.
    UPDATE public.training_provider
       SET ssg_api_base_url = 'http://ssg-mock:4010', ssg_default_app = 'app1', updated_at = NOW()
     WHERE id = v_provider;

    -- Chat launcher target: local Open WebUI (compose service open-webui). The app normally creates these two
    -- columns lazily when the Integrations form is saved; create them here so a rebuilt DB keeps the link.
    ALTER TABLE public.training_provider
        ADD COLUMN IF NOT EXISTS whatsapp_chat_url text,
        ADD COLUMN IF NOT EXISTS trainer_whatsapp_chat_url text;
    UPDATE public.training_provider
       SET whatsapp_chat_url = 'http://localhost:8081', trainer_whatsapp_chat_url = 'http://localhost:8081'
     WHERE id = v_provider;

    RAISE NOTICE 'Local admin ready: % | company: % | uen: %', v_email, v_company, v_uen;
END $$;
