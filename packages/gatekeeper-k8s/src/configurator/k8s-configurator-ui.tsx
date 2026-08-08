import { Field, Section, TextInput, h, type ConfiguratorUISpec } from "@gadgets/configurator-ui";

// Generic URL-paste configurator shared by all K8S gatekeeper resource types.
// The user pastes a resource URL like `k8s://cluster/ns/default` (or the agent's
// connection request pre-fills it) — no account RPC capability is needed.

type K8sConfiguratorValues = {
  url?: string | null;
};

// Empty RPC surface: the form derives the resource URL from the pasted value directly.
interface K8sConfiguratorRpc {}

export default {
  initial: {},

  initialValuesFromResourceUrl({ resourceUrl }) {
    return { url: resourceUrl };
  },

  isReady({ values }) {
    return typeof values.url === "string" && values.url.length > 0;
  },

  resourceUrl({ values }) {
    return values.url ?? "";
  },

  render({ values, setValues }) {
    return (
      <Section>
        <Field
          label="Resource URL"
          description={
            "Paste the URL of the resource to bind, e.g. " +
            "k8s://cluster/ns/default, k8s://cluster/ns/default/pods/nginx-abc123, " +
            "or argocd://apps/continue-story."
          }
        >
          <TextInput
            name="url"
            value={values.url ?? ""}
            onChange={url => setValues({ url })}
            placeholder="k8s://cluster/ns/default"
          />
        </Field>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<K8sConfiguratorRpc, K8sConfiguratorValues>;
