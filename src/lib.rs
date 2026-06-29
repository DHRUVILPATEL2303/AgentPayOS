#![cfg_attr(not(feature = "export-abi"), no_main)]
extern crate alloc;

use stylus_sdk::{
    alloy_primitives::*,
    alloy_sol_types::*,
    crypto::keccak,
    prelude::{errors::MethodError, *},
};

sol_interface! {
    interface IERC20 {
        function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    }
}

sol! {
    event ServiceRegistered(bytes32 indexed service_id, address indexed provider, address indexed token, string name, uint256 price);
    event AgentApproved(address indexed user, address indexed agent, uint256 allowance, uint256 expiration);
    event PaymentProcessed(bytes32 indexed service_id, address indexed user, address agent, address provider, uint256 amount);

    error ServiceInactive();
    error SessionExpired();
    error InsufficientAllowance();
    error TransferFailed();
    error NotServiceProvider();
}

sol_storage! {
    #[entrypoint]
    pub struct AgentPayOS {
        mapping(bytes32 => address) service_providers;
        mapping(bytes32 => uint256) prices;
        mapping(bytes32 => bool) is_service_active;
        mapping(bytes32 => address) service_tokens;

        // session based allowances to agents
        mapping(bytes32 => uint256) agent_allowances;
        mapping(bytes32 => uint256) agent_allowance_expirations;
    }
}

#[public]
impl AgentPayOS {
    pub fn register_service(
        &mut self,
        name: String,
        price: U256,
        token: Address,
    ) -> Result<FixedBytes<32>, Vec<u8>> {
        let sender = self.vm().msg_sender();
        let mut packed = Vec::new();
        packed.extend_from_slice(&name.as_bytes());
        packed.extend_from_slice(sender.as_slice());
        let service_id = keccak(&packed).into();

        self.service_providers.setter(service_id).set(sender);
        self.prices.setter(service_id).set(price);
        self.service_tokens.setter(service_id).set(token);
        self.is_service_active.setter(service_id).set(true);

        self.vm().log(ServiceRegistered {
            service_id,
            provider: sender,
            token,
            name,
            price,
        });

        Ok(service_id)
    }

    pub fn deactivate_service(&mut self, service_id: FixedBytes<32>) -> Result<(), Vec<u8>> {
        let sender = self.vm().msg_sender();
        let provider = self.service_providers.get(service_id);
        if sender != provider {
            return Err(NotServiceProvider {}.encode());
        }
        self.is_service_active.setter(service_id).set(false);
        Ok(())
    }

    pub fn reactivate_service(&mut self, service_id: FixedBytes<32>) -> Result<(), Vec<u8>> {
        let sender = self.vm().msg_sender();
        let provider = self.service_providers.get(service_id);
        if sender != provider {
            return Err(NotServiceProvider {}.encode());
        }
        self.is_service_active.setter(service_id).set(true);
        Ok(())
    }

    pub fn approve_agent(
        &mut self,
        agent: Address,
        allowance: U256,
        duration_seconds: U256,
    ) -> Result<(), Vec<u8>> {
        let user = self.vm().msg_sender();
        let session_key = self.compute_session_key(user, agent);
        let expiration = U256::from(self.vm().block_timestamp()) + duration_seconds;
        self.agent_allowances.setter(session_key).set(allowance);
        self.agent_allowance_expirations
            .setter(session_key)
            .set(expiration);

        self.vm().log(AgentApproved {
            user,
            agent,
            allowance,
            expiration,
        });

        Ok(())
    }

    pub fn pay_for_service(
        &mut self,
        user: Address,
        service_id: FixedBytes<32>,
    ) -> Result<(), Vec<u8>> {
        let agent = self.vm().msg_sender();
        let session_key = self.compute_session_key(user, agent);

        let provider = self.service_providers.get(service_id);
        let price = self.prices.get(service_id);
        let token = self.service_tokens.get(service_id);

        if !self.is_service_active.get(service_id) {
            return Err(ServiceInactive {}.encode());
        }

        let allowance = self.agent_allowances.get(session_key);
        let expiration = self.agent_allowance_expirations.get(session_key);

        if U256::from(self.vm().block_timestamp()) > expiration {
            return Err(SessionExpired {}.encode());
        }
        if allowance < price {
            return Err(InsufficientAllowance {}.encode());
        }


        self.agent_allowances
            .setter(session_key)
            .set(allowance - price);

        // erc20 call 
        let config = Call::new_mutating(self);
        let success = IERC20::new(token)
            .transfer_from(self.vm(), config, user, provider, price)
            .map_err(|_| TransferFailed {}.encode())?;

        if !success {
            return Err(TransferFailed {}.encode());
        }

        self.vm().log(PaymentProcessed {
            service_id,
            user,
            agent,
            provider,
            amount: price,
        });

        Ok(())
    }

    fn compute_session_key(&self, user: Address, agent: Address) -> FixedBytes<32> {
        let mut packed = Vec::new();
        packed.extend_from_slice(user.as_slice());
        packed.extend_from_slice(agent.as_slice());
        keccak(&packed).into()
    }
}
