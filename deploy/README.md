### helium-services/deploy

these are the ansible playbooks used to deploy our instance of helium-services.

the playbooks in this repo are written to configure machines running debian 12;
your mileage may vary on any other distributions.

the playbooks assume you are running a freshly installed version of the OS. if
your OS configurations deviate from defaults, you might run into problems.

### usage
- make sure ansible is installed on your system
- copy `hosts.yml.example` to `hosts.yml` and fill it out with your server(s)
- run `ansible-playbook all.yml`
