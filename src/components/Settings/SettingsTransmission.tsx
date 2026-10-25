import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings', {
  transmissionSettings: 'Transmission Settings',
  transmissionSettingsDescription:
    'Connect Transmission to show live download progress and control torrents from requests.',
  transmissionEnabled: 'Enable Transmission',
  transmissionHostname: 'Hostname or IP Address',
  transmissionPort: 'Port',
  transmissionUseSsl: 'Use SSL',
  transmissionRpcPath: 'RPC Path',
  transmissionUsername: 'Username',
  transmissionPassword: 'Password',
  transmissionTest: 'Test',
  transmissionTesting: 'Testing…',
  transmissionTestSuccess:
    'Transmission connection established! Version {version}',
  transmissionTestFailure: 'Failed to connect to Transmission.',
  transmissionSaveSuccess: 'Transmission settings saved successfully!',
  transmissionSaveFailure:
    'Something went wrong while saving Transmission settings.',
  transmissionValidationHostname: 'You must provide a hostname or IP address',
  transmissionValidationPort: 'You must provide a valid port number',
  transmissionValidationRpcPath: 'RPC path must have a leading slash',
});

interface TransmissionSettingsData {
  enabled: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
  rpcPath: string;
  username: string;
  password: string;
  hasPassword: boolean;
}

const SettingsTransmission = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<TransmissionSettingsData>(
    '/api/v1/settings/transmission'
  );
  const [isTesting, setIsTesting] = useState(false);

  const schema = Yup.object().shape({
    hostname: Yup.string().required(
      intl.formatMessage(messages.transmissionValidationHostname)
    ),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.transmissionValidationPort))
      .min(1, intl.formatMessage(messages.transmissionValidationPort))
      .max(65535, intl.formatMessage(messages.transmissionValidationPort)),
    rpcPath: Yup.string().matches(
      /^\//,
      intl.formatMessage(messages.transmissionValidationRpcPath)
    ),
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.transmissionSettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.transmissionSettingsDescription)}
        </p>
      </div>
      <Formik
        initialValues={{
          enabled: data?.enabled ?? false,
          hostname: data?.hostname ?? 'localhost',
          port: data?.port ?? 9091,
          useSsl: data?.useSsl ?? false,
          rpcPath: data?.rpcPath ?? '/transmission/rpc',
          username: data?.username ?? '',
          password: '',
        }}
        validationSchema={schema}
        onSubmit={async (values, { resetForm }) => {
          try {
            await axios.post('/api/v1/settings/transmission', {
              ...values,
              port: Number(values.port),
            });
            addToast(intl.formatMessage(messages.transmissionSaveSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
            resetForm({ values: { ...values, password: '' } });
          } catch {
            addToast(intl.formatMessage(messages.transmissionSaveFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            mutate();
          }
        }}
      >
        {({ errors, touched, values, handleSubmit, isSubmitting, isValid }) => {
          const runTest = async () => {
            setIsTesting(true);
            try {
              const res = await axios.post<{ version: string }>(
                '/api/v1/settings/transmission/test',
                { ...values, port: Number(values.port) }
              );
              addToast(
                intl.formatMessage(messages.transmissionTestSuccess, {
                  version: res.data.version,
                }),
                { autoDismiss: true, appearance: 'success' }
              );
            } catch {
              addToast(intl.formatMessage(messages.transmissionTestFailure), {
                autoDismiss: true,
                appearance: 'error',
              });
            } finally {
              setIsTesting(false);
            }
          };

          return (
            <form className="section" onSubmit={handleSubmit}>
              <div className="form-row">
                <label htmlFor="enabled" className="checkbox-label">
                  {intl.formatMessage(messages.transmissionEnabled)}
                </label>
                <div className="form-input-area">
                  <Field type="checkbox" id="enabled" name="enabled" />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="transmissionHostname" className="text-label">
                  {intl.formatMessage(messages.transmissionHostname)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      inputMode="url"
                      id="transmissionHostname"
                      name="hostname"
                    />
                  </div>
                  {errors.hostname && touched.hostname && (
                    <div className="error">{errors.hostname}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="transmissionPort" className="text-label">
                  {intl.formatMessage(messages.transmissionPort)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="text"
                    inputMode="numeric"
                    id="transmissionPort"
                    name="port"
                    className="short"
                  />
                  {errors.port && touched.port && (
                    <div className="error">{errors.port}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="transmissionUseSsl" className="checkbox-label">
                  {intl.formatMessage(messages.transmissionUseSsl)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="transmissionUseSsl"
                    name="useSsl"
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="transmissionRpcPath" className="text-label">
                  {intl.formatMessage(messages.transmissionRpcPath)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      id="transmissionRpcPath"
                      name="rpcPath"
                    />
                  </div>
                  {errors.rpcPath && touched.rpcPath && (
                    <div className="error">{errors.rpcPath}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="transmissionUsername" className="text-label">
                  {intl.formatMessage(messages.transmissionUsername)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      id="transmissionUsername"
                      name="username"
                    />
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="transmissionPassword" className="text-label">
                  {intl.formatMessage(messages.transmissionPassword)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="transmissionPassword"
                      name="password"
                      autoComplete="new-password"
                      placeholder={data?.hasPassword ? '••••••••' : ''}
                    />
                  </div>
                </div>
              </div>
              <div className="actions">
                <div className="flex justify-end">
                  <span className="inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="warning"
                      type="button"
                      disabled={isTesting || isSubmitting || !isValid}
                      onClick={runTest}
                    >
                      <BeakerIcon />
                      <span>
                        {isTesting
                          ? intl.formatMessage(messages.transmissionTesting)
                          : intl.formatMessage(messages.transmissionTest)}
                      </span>
                    </Button>
                  </span>
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || isTesting || !isValid}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </form>
          );
        }}
      </Formik>
    </>
  );
};

export default SettingsTransmission;
